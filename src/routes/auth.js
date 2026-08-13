import { Router } from 'express';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/tokens.js';
import { requireAuth } from '../auth/middleware.js';
import { logAudit, logAuditMany } from '../auth/audit.js';
import {
  normalizeEmail,
  normalizeUsername,
  isValidEmail,
  isValidUsername,
  isValidPassword,
  isValidAge,
  toPublicUser,
} from '../auth/validators.js';

export const authRouter = Router();

// Registro: primera vez que alguien activa su cuenta de GeoVS. Valida
// formato de cada campo y unicidad de email/username por separado, para que
// el cliente pueda mostrar el mensaje correcto ("cambia de correo" vs
// "cambia de nombre de usuario").
authRouter.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const age = req.body?.age;

  if (!isValidEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
  if (!isValidUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME' });
  if (!isValidPassword(password)) return res.status(400).json({ error: 'INVALID_PASSWORD' });
  if (!isValidAge(age)) return res.status(400).json({ error: 'INVALID_AGE' });

  const [emailTaken, usernameTaken] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);
  if (emailTaken) return res.status(409).json({ error: 'EMAIL_IN_USE' });
  if (usernameTaken) return res.status(409).json({ error: 'USERNAME_IN_USE' });

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, username, passwordHash, age: Number(age) },
  });

  await logAudit({ target: user, actor: user, field: 'account', newValue: 'created', reason: 'Registro de cuenta' });

  const token = signToken(user);
  res.status(201).json({ ok: true, token, user: toPublicUser(user) });
});

// Login: usuario + contrasena (no email, segun lo pedido). Mensaje de error
// generico a proposito (no revela si fallo el usuario o la contrasena).
authRouter.post('/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  if (user.blocked) return res.status(403).json({ error: 'ACCOUNT_BLOCKED' });

  const valid = await verifyPassword(String(password || ''), user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signToken(user);
  res.json({ ok: true, token, user: toPublicUser(user) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: toPublicUser(req.user) });
});

// Edicion de perfil: mismas reglas de validacion/unicidad que el registro,
// pero excluyendo al propio usuario de la comprobacion de unicidad. Registra
// un AuditLog por cada campo que efectivamente cambio.
authRouter.put('/profile', requireAuth, async (req, res) => {
  const current = req.user;
  const updates = {};
  const auditEntries = [];

  if (req.body?.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
    if (email !== current.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) return res.status(409).json({ error: 'EMAIL_IN_USE' });
      updates.email = email;
      auditEntries.push({ field: 'email', oldValue: current.email, newValue: email });
    }
  }

  if (req.body?.username !== undefined) {
    const username = normalizeUsername(req.body.username);
    if (!isValidUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME' });
    if (username !== current.username) {
      const taken = await prisma.user.findUnique({ where: { username } });
      if (taken) return res.status(409).json({ error: 'USERNAME_IN_USE' });
      updates.username = username;
      auditEntries.push({ field: 'username', oldValue: current.username, newValue: username });
    }
  }

  if (req.body?.age !== undefined) {
    if (!isValidAge(req.body.age)) return res.status(400).json({ error: 'INVALID_AGE' });
    const age = Number(req.body.age);
    if (age !== current.age) {
      updates.age = age;
      auditEntries.push({ field: 'age', oldValue: String(current.age), newValue: String(age) });
    }
  }

  if (req.body?.password !== undefined) {
    if (!isValidPassword(req.body.password)) return res.status(400).json({ error: 'INVALID_PASSWORD' });
    updates.passwordHash = await hashPassword(req.body.password);
    auditEntries.push({ field: 'password', oldValue: null, newValue: null });
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, user: toPublicUser(current) });
  }

  const updated = await prisma.user.update({ where: { id: current.id }, data: updates });

  if (auditEntries.length) {
    await logAuditMany(
      auditEntries.map((entry) => ({
        target: current,
        actor: current,
        field: entry.field,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        reason: 'Edicion de perfil',
      }))
    );
  }

  res.json({ ok: true, user: toPublicUser(updated) });
});
