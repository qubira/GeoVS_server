import { Router } from 'express';
import { prisma } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
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

export const adminRouter = Router();

const ROLES = ['player', 'developer', 'moderator', 'admin'];

// Todo /admin requiere estar logueado Y tener rol admin o moderator. Dentro,
// algunas acciones (cambiar rol, eliminar cuenta) se restringen ademas a
// admin, para que un moderador no pueda auto-ascenderse ni borrar cuentas.
adminRouter.use(requireAuth, requireRole('admin', 'moderator'));

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Usuarios ---------------------------------------------------------

adminRouter.get('/users', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const roleFilter = String(req.query.role || '');
  const where = {
    AND: [
      search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {},
      ROLES.includes(roleFilter) ? { role: roleFilter } : {},
    ],
  };
  const users = await prisma.user.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, users: users.map(toPublicUser) });
});

adminRouter.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true, user: toPublicUser(user) });
});

// Alta manual de cuenta desde el panel (mismas reglas de validacion/
// unicidad que el autoregistro; el admin/moderador puede fijar el rol de
// una vez, sin pasar por el flujo normal de "jugador por defecto").
adminRouter.post('/users', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const age = req.body?.age;
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'player';

  if (role !== 'player' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'ONLY_ADMIN_CAN_SET_ROLE' });
  }
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
  const user = await prisma.user.create({ data: { email, username, passwordHash, age: Number(age), role } });

  await logAudit({
    target: user,
    actor: req.user,
    field: 'account',
    newValue: 'created',
    reason: 'Creada manualmente desde el panel de administracion',
  });

  res.status(201).json({ ok: true, user: toPublicUser(user) });
});

// Edicion desde el panel: mismos campos que el autoservicio de perfil, mas
// `role` (solo admin) y `blocked` (admin o moderador, con motivo).
adminRouter.put('/users/:id', async (req, res) => {
  const current = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });

  const updates = {};
  const auditEntries = [];
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 300) : 'Editado desde el panel de administracion';

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

  if (req.body?.password !== undefined && req.body.password) {
    if (!isValidPassword(req.body.password)) return res.status(400).json({ error: 'INVALID_PASSWORD' });
    updates.passwordHash = await hashPassword(req.body.password);
    auditEntries.push({ field: 'password', oldValue: null, newValue: null });
  }

  if (req.body?.role !== undefined && req.body.role !== current.role) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'ONLY_ADMIN_CAN_SET_ROLE' });
    if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'INVALID_ROLE' });
    updates.role = req.body.role;
    auditEntries.push({ field: 'role', oldValue: current.role, newValue: req.body.role });
  }

  if (req.body?.blocked !== undefined && Boolean(req.body.blocked) !== current.blocked) {
    updates.blocked = Boolean(req.body.blocked);
    auditEntries.push({ field: 'blocked', oldValue: String(current.blocked), newValue: String(updates.blocked) });
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true, user: toPublicUser(current) });
  }

  const updated = await prisma.user.update({ where: { id: current.id }, data: updates });

  await logAuditMany(
    auditEntries.map((entry) => ({ target: current, actor: req.user, reason, ...entry }))
  );

  res.json({ ok: true, user: toPublicUser(updated) });
});

// Eliminar cuenta: solo admin. El AuditLog de la eliminacion (y todo el
// historial previo de esa cuenta) sobrevive porque userId es SetNull en el
// esquema (ver prisma/schema.prisma).
adminRouter.delete('/users/:id', requireRole('admin'), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'NOT_FOUND' });

  const reason = req.body?.reason ? String(req.body.reason).slice(0, 300) : 'Cuenta eliminada por un administrador';
  await logAudit({ target, actor: req.user, field: 'account', oldValue: 'active', newValue: 'deleted', reason });
  await prisma.user.delete({ where: { id: target.id } });

  res.json({ ok: true });
});

// --- Historial ----------------------------------------------------------

adminRouter.get('/audit-logs', async (req, res) => {
  // Se busca por userId O por targetUsername (no solo userId): si la cuenta
  // ya fue eliminada, userId queda en null (ver schema) pero el historial
  // sigue siendo encontrable por el nombre que tenia en ese momento.
  const userId = req.query.userId ? String(req.query.userId) : undefined;
  const username = req.query.username ? String(req.query.username) : undefined;
  const where = userId || username ? { OR: [userId ? { userId } : null, username ? { targetUsername: username } : null].filter(Boolean) } : undefined;
  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { changedAt: 'desc' },
    take: 200,
  });
  res.json({ ok: true, logs });
});

// --- Conexiones / analitica ---------------------------------------------

adminRouter.get('/connections/summary', async (req, res) => {
  const [totalUsers, byRole, logs] = await Promise.all([
    prisma.user.count(),
    prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
    prisma.connectionLog.findMany({
      orderBy: { connectedAt: 'desc' },
      take: 2000,
      include: { user: { select: { username: true } } },
    }),
  ]);

  const byCountry = new Map();
  const byUserTotal = new Map();
  const byUserByDay = new Map();
  let connectionsToday = 0;
  const today = dayKey(new Date());

  for (const log of logs) {
    const country = log.country || 'Desconocido';
    byCountry.set(country, (byCountry.get(country) || 0) + 1);

    const duration = log.durationSec ?? Math.max(0, Math.round((Date.now() - log.connectedAt.getTime()) / 1000));
    const uname = log.user?.username || log.userId;
    byUserTotal.set(uname, (byUserTotal.get(uname) || 0) + duration);

    const key = `${uname}|${dayKey(log.connectedAt)}`;
    byUserByDay.set(key, (byUserByDay.get(key) || 0) + duration);

    if (dayKey(log.connectedAt) === today) connectionsToday += 1;
  }

  res.json({
    ok: true,
    totalUsers,
    byRole: byRole.map((r) => ({ role: r.role, count: r._count.role })),
    connectionsToday,
    byCountry: [...byCountry.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count),
    topByTotalTime: [...byUserTotal.entries()]
      .map(([username, seconds]) => ({ username, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 20),
  });
});

// --- Lista de espera (landing page) --------------------------------------
// La tabla `waitlist` pertenece al proyecto de la landing (otro Prisma,
// mismo Neon, schema "public"). Se lee via SQL crudo, calificando el
// schema explicitamente, para no mezclarla con el modelo `User` de este
// servidor (schema "geovs_accounts").
adminRouter.get('/waitlist', async (req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT id, name, email, "createdAt"
    FROM public.waitlist
    ORDER BY "createdAt" DESC
    LIMIT 500
  `;
  res.json({ ok: true, entries: rows });
});

adminRouter.delete('/waitlist/:id', requireRole('admin'), async (req, res) => {
  await prisma.$executeRaw`DELETE FROM public.waitlist WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

adminRouter.get('/users/:id/connections', async (req, res) => {
  const logs = await prisma.connectionLog.findMany({
    where: { userId: req.params.id },
    orderBy: { connectedAt: 'desc' },
    take: 500,
  });

  const byDay = new Map();
  let totalSec = 0;
  for (const log of logs) {
    const duration = log.durationSec ?? Math.max(0, Math.round((Date.now() - log.connectedAt.getTime()) / 1000));
    totalSec += duration;
    const key = dayKey(log.connectedAt);
    byDay.set(key, (byDay.get(key) || 0) + duration);
  }

  res.json({
    ok: true,
    totalSec,
    byDay: [...byDay.entries()].map(([day, seconds]) => ({ day, seconds })).sort((a, b) => (a.day < b.day ? 1 : -1)),
    sessions: logs.map((l) => ({
      id: l.id,
      ip: l.ip,
      country: l.country,
      countryCode: l.countryCode,
      connectedAt: l.connectedAt,
      disconnectedAt: l.disconnectedAt,
      durationSec: l.durationSec,
    })),
  });
});
