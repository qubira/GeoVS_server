import { Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { logAudit, logAuditMany } from '../auth/audit.js';
import { listLevels, syncCustomLevelInMemory, removeCustomLevelFromMemory } from '../game/levels.js';
import { PHYSICS } from '../config.js';
import { uploadBuffer } from '../utils/cloudinary.js';
import { kickUser } from '../moderation/kick.js';
import { maybeAutoBlockIp, isIpBlocked } from '../moderation/ipBlock.js';
import { clientIpFromRequest } from '../utils/geoip.js';
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

// Todo /admin requiere estar logueado Y tener rol admin, moderator o
// developer. El rol developer solo debe poder usar el modulo "Crear"
// (uploads/avatares/objetos/pistas personalizadas) — las secciones de
// cuentas/historial/conexiones/lista de espera se restringen aparte, mas
// abajo, a admin/moderator igual que ya se hacia con acciones puntuales
// (cambiar rol, eliminar cuenta) que se restringen ademas a admin.
adminRouter.use(requireAuth, requireRole('admin', 'moderator', 'developer'));

// Secciones que developer NO debe ver ni usar (todo lo que no es el modulo
// "Crear"): se les aplica un segundo gate mas estricto, con el mismo patron
// ya usado en rutas puntuales de abajo (DELETE /users/:id, DELETE
// /waitlist/:id).
adminRouter.use(['/users', '/audit-logs', '/connections', '/accounts', '/levels', '/waitlist'], requireRole('admin', 'moderator'));

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Convierte un string de query param a Date valida, o null si esta vacio o
// mal formado (evita mandarle un Invalid Date a Prisma) — usado por los
// filtros avanzados de fecha en varias secciones del panel.
function parseDateParam(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Resuelve una ventana de fechas [start, end) a partir de los query params
// `range` (day|week|month, default day) y `date` (YYYY-MM-DD, default hoy).
// "Hoy" es simplemente range=day sin date. Se mantiene todo en UTC, igual que
// dayKey() de arriba — no vale la pena agregar una libreria de timezone para
// un dashboard de metricas.
function rangeWindow(req) {
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : dayKey(new Date());
  const end = new Date(`${dateStr}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1); // fin del dia seleccionado (exclusive)
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  return { start, end, range, date: dateStr };
}

// --- Usuarios ---------------------------------------------------------

adminRouter.get('/users', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const roleFilter = String(req.query.role || '');
  const blockedFilter = req.query.blocked; // 'true' | 'false' | undefined (sin filtrar)
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);
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
      blockedFilter === 'true' || blockedFilter === 'false' ? { blocked: blockedFilter === 'true' } : {},
      dateFrom ? { createdAt: { gte: dateFrom } } : {},
      dateTo ? { createdAt: { lte: dateTo } } : {},
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
  const field = req.query.field ? String(req.query.field) : undefined;
  const changedBy = req.query.changedBy ? String(req.query.changedBy).trim() : undefined;
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);

  const where = {
    AND: [
      userId || username ? { OR: [userId ? { userId } : null, username ? { targetUsername: username } : null].filter(Boolean) } : {},
      field ? { field } : {},
      changedBy ? { changedByUsername: { contains: changedBy, mode: 'insensitive' } } : {},
      dateFrom ? { changedAt: { gte: dateFrom } } : {},
      dateTo ? { changedAt: { lte: dateTo } } : {},
    ],
  };

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { changedAt: 'desc' },
    take: 200,
  });
  res.json({ ok: true, logs });
});

// --- Conexiones / analitica ---------------------------------------------

adminRouter.get('/connections/summary', async (req, res) => {
  const { start, end } = rangeWindow(req);
  const [totalUsers, byRole, connectionsInRange, playSessions] = await Promise.all([
    prisma.user.count(),
    prisma.user.groupBy({ by: ['role'], _count: { role: true } }),
    prisma.connectionLog.count({ where: { connectedAt: { gte: start, lt: end } } }),
    // "Mas tiempo conectado" ahora se calcula desde PlaySession (tiempo
    // JUGANDO, no tiempo conectado): sentarse en menus/lobby sin jugar ya no
    // suma aqui, solo las rondas activas (ver Room.js _openPlaySession/
    // _closePlaySession).
    prisma.playSession.findMany({
      where: { startedAt: { gte: start, lt: end } },
      take: 3000,
      select: { userId: true, durationSec: true, startedAt: true, user: { select: { username: true } } },
    }),
  ]);

  const byUserTotal = new Map();
  for (const s of playSessions) {
    const duration = s.durationSec ?? Math.max(0, Math.round((Date.now() - s.startedAt.getTime()) / 1000));
    const prev = byUserTotal.get(s.userId);
    byUserTotal.set(s.userId, { userId: s.userId, username: s.user?.username || s.userId, seconds: (prev?.seconds || 0) + duration });
  }

  res.json({
    ok: true,
    totalUsers,
    byRole: byRole.map((r) => ({ role: r.role, count: r._count.role })),
    connectionsInRange,
    topByTotalTime: [...byUserTotal.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 20),
  });
});

// Cuentas conectadas AHORA MISMO por pais (para el panel "en vivo", con
// polling). Distinto de /accounts/with-session-by-country, que es historico.
adminRouter.get('/connections/online-by-country', async (_req, res) => {
  const rows = await prisma.connectionLog.groupBy({
    by: ['country'],
    where: { disconnectedAt: null },
    _count: { _all: true },
  });
  const byCountry = rows
    .map((r) => ({ country: r.country || 'Desconocido', count: r._count._all }))
    .sort((a, b) => b.count - a.count);
  res.json({ ok: true, totalOnline: byCountry.reduce((sum, c) => sum + c.count, 0), byCountry });
});

// Cuentas DISTINTAS que tuvieron al menos una sesion por pais, en el rango
// seleccionado (historico/acumulado). Si una cuenta se conecto desde dos
// paises en el rango, cuenta una vez en cada uno.
adminRouter.get('/accounts/with-session-by-country', async (req, res) => {
  const { start, end } = rangeWindow(req);
  const logs = await prisma.connectionLog.findMany({
    where: { connectedAt: { gte: start, lt: end } },
    select: { userId: true, country: true },
  });
  const seen = new Set();
  const byCountry = new Map();
  for (const log of logs) {
    const country = log.country || 'Desconocido';
    const key = `${log.userId}|${country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byCountry.set(country, (byCountry.get(country) || 0) + 1);
  }
  res.json({
    ok: true,
    byCountry: [...byCountry.entries()].map(([country, accounts]) => ({ country, accounts })).sort((a, b) => b.accounts - a.accounts),
  });
});

// Niveles mas jugados: ranking general, por pais, y top jugadores por nivel.
adminRouter.get('/levels/popularity', async (req, res) => {
  const { start, end } = rangeWindow(req);
  const sessions = await prisma.playSession.findMany({
    where: { startedAt: { gte: start, lt: end } },
    take: 5000,
    select: { levelId: true, country: true, userId: true, user: { select: { username: true } } },
  });

  const names = Object.fromEntries(listLevels().map((l) => [l.id, l.name]));
  const overall = new Map();
  const byCountry = new Map();
  const byPlayer = new Map();

  for (const s of sessions) {
    const o = overall.get(s.levelId) || { levelId: s.levelId, levelName: names[s.levelId] || s.levelId, sessionCount: 0 };
    o.sessionCount += 1;
    overall.set(s.levelId, o);

    const country = s.country || 'Desconocido';
    const ck = `${s.levelId}|${country}`;
    byCountry.set(ck, { levelId: s.levelId, country, count: (byCountry.get(ck)?.count || 0) + 1 });

    const pk = `${s.levelId}|${s.userId}`;
    const p = byPlayer.get(pk) || { levelId: s.levelId, userId: s.userId, username: s.user?.username || s.userId, sessionCount: 0 };
    p.sessionCount += 1;
    byPlayer.set(pk, p);
  }

  res.json({
    ok: true,
    overall: [...overall.values()].sort((a, b) => b.sessionCount - a.sessionCount),
    byCountry: [...byCountry.values()].sort((a, b) => b.count - a.count),
    topPlayers: [...byPlayer.values()].sort((a, b) => b.sessionCount - a.sessionCount).slice(0, 20),
  });
});

// Timestamps crudos de PlaySession.startedAt para el histograma de "horas
// pico" de un jugador. Se bucketiza por hora en el cliente (getHours(), hora
// local del navegador del admin) en vez de aqui, para no tener que adivinar
// una zona horaria "correcta" en el servidor.
adminRouter.get('/users/:id/peak-hours', async (req, res) => {
  const { start, end } = rangeWindow(req);
  const sessions = await prisma.playSession.findMany({
    where: { userId: req.params.id, startedAt: { gte: start, lt: end } },
    orderBy: { startedAt: 'desc' },
    take: 3000,
    select: { startedAt: true },
  });
  res.json({ ok: true, source: 'playSession', timestamps: sessions.map((s) => s.startedAt) });
});

// Sesiones recientes desde un pais dado, para poder "entrar" al detalle
// desde la fila de "Conexiones por pais" del resumen.
adminRouter.get('/connections/by-country', async (req, res) => {
  const country = String(req.query.country || '');
  const where = country === 'Desconocido' ? { country: null } : { country };
  const logs = await prisma.connectionLog.findMany({
    where,
    orderBy: { connectedAt: 'desc' },
    take: 100,
    include: { user: { select: { id: true, username: true, role: true } } },
  });
  res.json({
    ok: true,
    sessions: logs.map((l) => ({
      id: l.id,
      userId: l.userId,
      username: l.user?.username || l.userId,
      role: l.user?.role || null,
      ip: l.ip,
      connectedAt: l.connectedAt,
      disconnectedAt: l.disconnectedAt,
      durationSec: l.durationSec,
    })),
  });
});

// --- Conversaciones (moderacion) -----------------------------------------
// Restringido a admin/moderator igual que el resto de las secciones que no
// son el modulo "Crear" (ver el gate de arriba).
adminRouter.use('/chat-messages', requireRole('admin', 'moderator'));

adminRouter.get('/chat-messages', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const roomCode = String(req.query.roomCode || '').trim();
  const onlyAccounts = req.query.onlyAccounts === 'true';
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 50;

  const where = {
    AND: [
      search ? { text: { contains: search, mode: 'insensitive' } } : {},
      roomCode ? { roomCode: { contains: roomCode, mode: 'insensitive' } } : {},
      onlyAccounts ? { userId: { not: null } } : {},
      dateFrom ? { createdAt: { gte: dateFrom } } : {},
      dateTo ? { createdAt: { lte: dateTo } } : {},
    ],
  };

  const [messages, total] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.chatMessage.count({ where }),
  ]);

  // Conteo de alertas por usuario, para que el panel pueda mostrar "2/3
  // alertas" ANTES de intentar mandar una nueva (antes solo se enteraba
  // despues, cuando el servidor la rechazaba por haber llegado al limite).
  const userIds = [...new Set(messages.map((m) => m.userId).filter(Boolean))];
  const warningCounts = userIds.length
    ? await prisma.warning.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } })
    : [];
  const warningCountByUserId = Object.fromEntries(warningCounts.map((w) => [w.userId, w._count._all]));

  res.json({
    ok: true,
    messages: messages.map((m) => ({ ...m, warningCount: m.userId ? warningCountByUserId[m.userId] || 0 : null })),
    total,
    page,
    pageSize,
  });
});

// --- Moderacion: bloqueo, alertas y motivos ------------------------------
// Mismo gate que Conversaciones (admin/moderator, no developer).
const WARNING_LIMIT = 3;
adminRouter.use(['/moderation', '/account-blocks', '/block-reasons'], requireRole('admin', 'moderator'));

async function snapshotMessage(messageId) {
  if (!messageId) return null;
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  return msg?.text || null;
}

// Metricas de moderacion para la tarjeta nueva del Resumen: cuentas
// bloqueadas activas (total, no depende del rango), y lo demas si acotado
// al rango elegido (igual que el resto del dashboard).
adminRouter.get('/moderation/summary', async (req, res) => {
  const { start, end } = rangeWindow(req);
  const [activeBlocks, warningsInRange, ipBlocksCount, messagesInRange, blockReasonUsage, warningReasonUsage] = await Promise.all([
    prisma.accountBlock.count({ where: { active: true } }),
    prisma.warning.count({ where: { createdAt: { gte: start, lt: end } } }),
    prisma.ipBlock.count(),
    prisma.chatMessage.count({ where: { createdAt: { gte: start, lt: end } } }),
    prisma.accountBlock.groupBy({ by: ['reasonId'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true } }),
    prisma.warning.groupBy({ by: ['reasonId'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true } }),
  ]);

  const reasons = await prisma.blockReason.findMany({ select: { id: true, label: true } });
  const labelById = Object.fromEntries(reasons.map((r) => [r.id, r.label]));
  const combinedByReason = new Map();
  for (const row of [...blockReasonUsage, ...warningReasonUsage]) {
    const label = labelById[row.reasonId] || 'Motivo eliminado';
    combinedByReason.set(label, (combinedByReason.get(label) || 0) + row._count._all);
  }
  const topReasons = [...combinedByReason.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({ ok: true, activeBlocks, warningsInRange, ipBlocksCount, messagesInRange, topReasons });
});

// Bloquea una cuenta: crea el historial (AccountBlock), marca User.blocked
// (eso es lo que ya rechaza el login desde antes de este modulo) y expulsa
// cualquier sesion que tenga abierta AHORA MISMO.
adminRouter.post('/moderation/block', async (req, res) => {
  const userId = String(req.body?.userId || '');
  const reasonId = String(req.body?.reasonId || '');
  const messageId = req.body?.messageId ? String(req.body.messageId) : null;
  if (!userId) return res.status(400).json({ error: 'INVALID_USER' });

  const [user, reason] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.blockReason.findUnique({ where: { id: reasonId } }),
  ]);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (!reason) return res.status(400).json({ error: 'INVALID_REASON' });

  const messageText = await snapshotMessage(messageId);
  const block = await prisma.accountBlock.create({
    data: {
      userId,
      reasonId,
      messageId,
      messageText,
      blockedBy: req.user.id,
      blockedByName: req.user.username,
    },
  });
  await prisma.user.update({ where: { id: userId }, data: { blocked: true } });
  await logAudit({ target: user, actor: req.user, field: 'blocked', oldValue: 'false', newValue: 'true', reason: reason.label });
  kickUser(userId, reason.label);
  await maybeAutoBlockIp(userId);

  res.status(201).json({ ok: true, block });
});

// Alerta (llamado de atencion) a una o varias cuentas de una sola vez. A la
// cuenta que YA tiene 3 alertas o mas no se le crea una mas — se devuelve en
// `blockedInstead` para que el panel le ofrezca bloquear en su lugar.
adminRouter.post('/moderation/warn', async (req, res) => {
  const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(String))] : [];
  const reasonId = String(req.body?.reasonId || '');
  const messageId = req.body?.messageId ? String(req.body.messageId) : null;
  if (!userIds.length) return res.status(400).json({ error: 'INVALID_USERS' });

  const reason = await prisma.blockReason.findUnique({ where: { id: reasonId } });
  if (!reason) return res.status(400).json({ error: 'INVALID_REASON' });

  const targets = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } });
  const targetById = Object.fromEntries(targets.map((u) => [u.id, u]));

  const messageText = await snapshotMessage(messageId);
  const warned = [];
  const blockedInstead = [];
  const auditEntries = [];

  for (const userId of userIds) {
    const priorCount = await prisma.warning.count({ where: { userId } });
    if (priorCount >= WARNING_LIMIT) {
      blockedInstead.push(userId);
      continue;
    }
    const warning = await prisma.warning.create({
      data: { userId, reasonId, messageId, messageText, issuedBy: req.user.id, issuedByName: req.user.username },
    });
    warned.push(warning);
    // Antes solo los bloqueos quedaban en Historial — las alertas tambien
    // deberian ser auditables (quien alerto a quien, por que y cuando).
    const target = targetById[userId];
    if (target) {
      auditEntries.push({ target, actor: req.user, field: 'warned', newValue: reason.label, reason: messageText || undefined });
    }
  }
  if (auditEntries.length) await logAuditMany(auditEntries);

  res.status(201).json({ ok: true, warned, blockedInstead });
});

adminRouter.get('/account-blocks', async (req, res) => {
  const onlyActive = req.query.active !== 'false';
  const search = String(req.query.search || '').trim();
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);

  // AccountBlock.userId es un string suelto (no una relacion Prisma a User),
  // asi que buscar por nombre de usuario primero resuelve los ids que
  // matchean y despues se usan como filtro — el motivo si es una relacion
  // real (BlockReason), esa parte se filtra directo.
  let matchingUserIds = [];
  if (search) {
    const matchingUsers = await prisma.user.findMany({ where: { username: { contains: search, mode: 'insensitive' } }, select: { id: true } });
    matchingUserIds = matchingUsers.map((u) => u.id);
  }

  const where = {
    AND: [
      onlyActive ? { active: true } : {},
      dateFrom ? { createdAt: { gte: dateFrom } } : {},
      dateTo ? { createdAt: { lte: dateTo } } : {},
      search
        ? {
            OR: [
              { userId: { in: matchingUserIds } },
              { reason: { label: { contains: search, mode: 'insensitive' } } },
              { messageText: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  };

  const blocks = await prisma.accountBlock.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { reason: { select: { label: true } } },
  });
  const users = await prisma.user.findMany({ where: { id: { in: blocks.map((b) => b.userId) } }, select: { id: true, username: true } });
  const usernameById = Object.fromEntries(users.map((u) => [u.id, u.username]));
  res.json({
    ok: true,
    blocks: blocks.map((b) => ({ ...b, username: usernameById[b.userId] || null, reasonLabel: b.reason.label })),
  });
});

adminRouter.put('/account-blocks/:id/unblock', async (req, res) => {
  const block = await prisma.accountBlock.update({ where: { id: req.params.id }, data: { active: false } }).catch(() => null);
  if (!block) return res.status(404).json({ error: 'NOT_FOUND' });
  await prisma.user.update({ where: { id: block.userId } , data: { blocked: false } }).catch(() => null);
  res.json({ ok: true });
});

adminRouter.get('/block-reasons', async (_req, res) => {
  const reasons = await prisma.blockReason.findMany({ orderBy: { createdAt: 'asc' } });
  res.json({ ok: true, reasons });
});

adminRouter.post('/block-reasons', async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'INVALID_LABEL' });
  const taken = await prisma.blockReason.findUnique({ where: { label } });
  if (taken) return res.status(409).json({ error: 'LABEL_IN_USE' });
  const reason = await prisma.blockReason.create({ data: { label } });
  res.status(201).json({ ok: true, reason });
});

adminRouter.delete('/block-reasons/:id', async (req, res) => {
  // Se verifica el uso a mano (en vez de solo confiar en la restriccion de
  // clave foranea de la base): la violacion RESTRICT llega desde Postgres
  // como un error generico sin el codigo P2003 que Prisma normalmente
  // traduce, asi que intentar reconocerla por codigo de error no es
  // confiable — mejor evitar el intento de borrado del todo si ya se sabe
  // que va a fallar.
  const [blockCount, warningCount] = await Promise.all([
    prisma.accountBlock.count({ where: { reasonId: req.params.id } }),
    prisma.warning.count({ where: { reasonId: req.params.id } }),
  ]);
  if (blockCount > 0 || warningCount > 0) return res.status(409).json({ error: 'REASON_IN_USE' });

  const deleted = await prisma.blockReason.delete({ where: { id: req.params.id } }).catch(() => null);
  if (!deleted) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

// --- Lista negra de IP ----------------------------------------------------
adminRouter.use('/ip-blocks', requireRole('admin', 'moderator'));

adminRouter.get('/ip-blocks', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const where = search
    ? { OR: [{ ip: { contains: search } }, { reason: { contains: search, mode: 'insensitive' } }] }
    : undefined;
  const blocks = await prisma.ipBlock.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, blocks });
});

adminRouter.post('/ip-blocks', async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!ip) return res.status(400).json({ error: 'INVALID_IP' });
  if (!reason) return res.status(400).json({ error: 'INVALID_REASON' });
  const taken = await prisma.ipBlock.findUnique({ where: { ip } });
  if (taken) return res.status(409).json({ error: 'IP_ALREADY_BLOCKED' });
  const block = await prisma.ipBlock.create({ data: { ip, reason, blockedBy: req.user.username } });
  res.status(201).json({ ok: true, block });
});

adminRouter.delete('/ip-blocks/:id', async (req, res) => {
  await prisma.ipBlock.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// Cuentas vistas conectandose desde una IP dada — reutiliza ConnectionLog
// (ya tiene ip+userId), no hace falta guardar esa relacion aparte.
adminRouter.get('/ip-blocks/:ip/accounts', async (req, res) => {
  const logs = await prisma.connectionLog.findMany({
    where: { ip: req.params.ip },
    distinct: ['userId'],
    orderBy: { connectedAt: 'desc' },
    include: { user: { select: { id: true, username: true, blocked: true, role: true } } },
  });
  res.json({ ok: true, accounts: logs.map((l) => l.user).filter(Boolean) });
});

// --- Modulo "Crear": avatares, objetos y niveles personalizados ---------

const ALLOWED_UPLOAD_KINDS = {
  avatar: /^image\//,
  object: /^image\//,
  background: /^image\//,
  music: /^audio\//,
};
// 8MB alcanzaba para imagenes pero no para musica real (un mp3/wav de unos
// minutos facil pasa eso) — la subida se quedaba trabada porque multer
// tira el error ANTES de que corra el handler de la ruta, sin pasar por el
// try/catch de abajo, asi que el cliente veia un error generico sin poder
// saber que era por el tamaño. 25MB alcanza para una cancion normal.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

function handleUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'FILE_TOO_LARGE', maxBytes: MAX_UPLOAD_BYTES });
    }
    console.error('Error de multer al recibir el archivo:', err);
    res.status(400).json({ error: 'UPLOAD_FAILED' });
  });
}

adminRouter.post('/uploads', handleUploadMiddleware, async (req, res) => {
  const kind = String(req.body?.kind || '');
  const mimePattern = ALLOWED_UPLOAD_KINDS[kind];
  if (!mimePattern) return res.status(400).json({ error: 'INVALID_KIND' });
  if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
  if (!mimePattern.test(req.file.mimetype)) return res.status(400).json({ error: 'INVALID_FILE_TYPE' });

  try {
    const result = await uploadBuffer(req.file.buffer, kind);
    res.status(201).json({ ok: true, url: result.secure_url });
  } catch (err) {
    console.error('Error subiendo archivo a Cloudinary:', err);
    res.status(502).json({ error: 'UPLOAD_FAILED' });
  }
});

// --- Avatares personalizados ---------------------------------------------

adminRouter.get('/custom-avatars', async (_req, res) => {
  const avatars = await prisma.customAvatar.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, avatars });
});

adminRouter.post('/custom-avatars', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const imageUrl = String(req.body?.imageUrl || '').trim();
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  if (!imageUrl) return res.status(400).json({ error: 'INVALID_IMAGE' });
  // Siempre arranca como borrador (published:false) — publicar es una accion
  // separada (ver /publish mas abajo), asi no queda jugable por accidente.
  const avatar = await prisma.customAvatar.create({ data: { name, imageUrl, createdBy: req.user.id } });
  res.status(201).json({ ok: true, avatar });
});

adminRouter.put('/custom-avatars/:id/publish', async (req, res) => {
  const published = Boolean(req.body?.published);
  const avatar = await prisma.customAvatar.update({ where: { id: req.params.id }, data: { published } }).catch(() => null);
  if (!avatar) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true, avatar });
});

adminRouter.delete('/custom-avatars/:id', async (req, res) => {
  await prisma.customAvatar.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// --- Tipos de objeto personalizados ---------------------------------------

const PHYSICS_TYPES = ['spike', 'block', 'platform'];

adminRouter.get('/custom-object-types', async (_req, res) => {
  const objectTypes = await prisma.customObjectType.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, objectTypes });
});

adminRouter.post('/custom-object-types', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const imageUrl = String(req.body?.imageUrl || '').trim();
  const physicsType = String(req.body?.physicsType || '');
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  if (!imageUrl) return res.status(400).json({ error: 'INVALID_IMAGE' });
  if (!PHYSICS_TYPES.includes(physicsType)) return res.status(400).json({ error: 'INVALID_PHYSICS_TYPE' });
  const objectType = await prisma.customObjectType.create({ data: { name, imageUrl, physicsType, createdBy: req.user.id } });
  res.status(201).json({ ok: true, objectType });
});

adminRouter.delete('/custom-object-types/:id', async (req, res) => {
  await prisma.customObjectType.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// --- Pistas/niveles personalizados -----------------------------------------

// `length` SIEMPRE se recalcula en el servidor a partir de speedX/durationSec
// — nunca se confia en uno que mande el cliente, es el campo que la fisica
// usa para decidir la meta (ver game/PhysicsEngine.js).
function computeLength(speedX, durationSec) {
  return Math.round((speedX ?? PHYSICS.SPEED_X) * durationSec);
}

function validateLevelBody(body) {
  const name = String(body?.name || '').trim().slice(0, 60);
  const durationSec = Number(body?.durationSec);
  const speedX = body?.speedX !== undefined && body.speedX !== null && body.speedX !== '' ? Number(body.speedX) : null;
  const jumpVelocity = body?.jumpVelocity !== undefined && body.jumpVelocity !== null && body.jumpVelocity !== '' ? Number(body.jumpVelocity) : null;
  const backgroundScale = body?.backgroundScale !== undefined && body.backgroundScale !== null && body.backgroundScale !== '' ? Number(body.backgroundScale) : null;
  const musicStartSec = Number.isFinite(Number(body?.musicStartSec)) ? Math.max(0, Number(body.musicStartSec)) : 0;
  const musicEndSec = body?.musicEndSec !== undefined && body.musicEndSec !== null && body.musicEndSec !== '' ? Number(body.musicEndSec) : null;
  const obstacles = Array.isArray(body?.obstacles) ? body.obstacles : null;
  const checkpoints = Array.isArray(body?.checkpoints) ? body.checkpoints : [0];

  if (!name) return { error: 'INVALID_NAME' };
  if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 600) return { error: 'INVALID_DURATION' };
  if (speedX !== null && (!Number.isFinite(speedX) || speedX < 100 || speedX > 1200)) return { error: 'INVALID_SPEED' };
  if (jumpVelocity !== null && (!Number.isFinite(jumpVelocity) || jumpVelocity > -300 || jumpVelocity < -2000)) return { error: 'INVALID_JUMP' };
  if (backgroundScale !== null && (!Number.isFinite(backgroundScale) || backgroundScale < 0.3 || backgroundScale > 4)) return { error: 'INVALID_BACKGROUND_SCALE' };
  if (musicEndSec !== null && (!Number.isFinite(musicEndSec) || musicEndSec <= musicStartSec)) return { error: 'INVALID_MUSIC_TRIM' };
  if (!obstacles) return { error: 'INVALID_OBSTACLES' };
  for (const o of obstacles) {
    if (!PHYSICS_TYPES.includes(o?.type)) return { error: 'INVALID_OBSTACLE_TYPE' };
    if (![o.x, o.y, o.w, o.h].every((n) => Number.isFinite(Number(n)))) return { error: 'INVALID_OBSTACLE_SHAPE' };
  }

  const length = computeLength(speedX, durationSec);
  if (obstacles.some((o) => Number(o.x) + Number(o.w) > length)) {
    return { error: 'OBSTACLE_OUT_OF_BOUNDS' };
  }

  return {
    data: {
      name,
      durationSec: Math.round(durationSec),
      speedX,
      jumpVelocity,
      length,
      backgroundImageUrl: body?.backgroundImageUrl ? String(body.backgroundImageUrl).trim() : null,
      backgroundScale,
      musicUrl: body?.musicUrl ? String(body.musicUrl).trim() : null,
      musicStartSec,
      musicEndSec,
      obstacles: obstacles.map((o) => ({
        type: o.type,
        x: Math.round(Number(o.x)),
        y: Math.round(Number(o.y)),
        w: Math.round(Number(o.w)),
        h: Math.round(Number(o.h)),
        ...(o.imageUrl ? { imageUrl: String(o.imageUrl) } : {}),
      })),
      checkpoints,
    },
  };
}

adminRouter.get('/custom-levels', async (_req, res) => {
  const levels = await prisma.customLevel.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ ok: true, levels });
});

adminRouter.get('/custom-levels/:id', async (req, res) => {
  const level = await prisma.customLevel.findUnique({ where: { id: req.params.id } });
  if (!level) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true, level });
});

adminRouter.post('/custom-levels', async (req, res) => {
  const { data, error } = validateLevelBody(req.body);
  if (error) return res.status(400).json({ error });
  // Arranca como borrador (published:false, default del schema) — no la
  // sincronizamos como "visible" hasta que se publique explicitamente.
  const level = await prisma.customLevel.create({ data: { ...data, createdBy: req.user.id } });
  syncCustomLevelInMemory(level);
  res.status(201).json({ ok: true, level });
});

adminRouter.put('/custom-levels/:id', async (req, res) => {
  const current = await prisma.customLevel.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = validateLevelBody(req.body);
  if (error) return res.status(400).json({ error });
  // No toca `published`: editar una pista publicada la mantiene publicada
  // (con el contenido nuevo), editar un borrador lo mantiene en borrador.
  const level = await prisma.customLevel.update({ where: { id: current.id }, data });
  syncCustomLevelInMemory(level);
  res.json({ ok: true, level });
});

adminRouter.put('/custom-levels/:id/publish', async (req, res) => {
  const published = Boolean(req.body?.published);
  const level = await prisma.customLevel.update({ where: { id: req.params.id }, data: { published } }).catch(() => null);
  if (!level) return res.status(404).json({ error: 'NOT_FOUND' });
  syncCustomLevelInMemory(level);
  res.json({ ok: true, level });
});

adminRouter.delete('/custom-levels/:id', async (req, res) => {
  await prisma.customLevel.delete({ where: { id: req.params.id } }).catch(() => null);
  removeCustomLevelFromMemory(req.params.id);
  res.json({ ok: true });
});

// --- Lista de espera (landing page) --------------------------------------
// La tabla `waitlist` pertenece al proyecto de la landing (otro Prisma,
// mismo Neon, schema "public"). Se lee via SQL crudo, calificando el
// schema explicitamente, para no mezclarla con el modelo `User` de este
// servidor (schema "geovs_accounts").
adminRouter.get('/waitlist', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);

  // Tabla cruda (no es un modelo Prisma), asi que el filtro se arma con
  // Prisma.sql/Prisma.join en vez de un objeto `where` — sigue parametrizado
  // (sin riesgo de inyeccion), solo cambia la forma de construirlo.
  const conditions = [];
  if (search) conditions.push(Prisma.sql`(name ILIKE ${'%' + search + '%'} OR email ILIKE ${'%' + search + '%'})`);
  if (dateFrom) conditions.push(Prisma.sql`"createdAt" >= ${dateFrom}`);
  if (dateTo) conditions.push(Prisma.sql`"createdAt" <= ${dateTo}`);
  const whereClause = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const rows = await prisma.$queryRaw`
    SELECT id, name, email, "createdAt"
    FROM public.waitlist
    ${whereClause}
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
  const [logs, playSessions] = await Promise.all([
    prisma.connectionLog.findMany({ where: { userId: req.params.id }, orderBy: { connectedAt: 'desc' }, take: 500 }),
    prisma.playSession.findMany({ where: { userId: req.params.id }, orderBy: { startedAt: 'desc' }, take: 500 }),
  ]);

  const byDay = new Map();
  let totalSec = 0;
  for (const log of logs) {
    const duration = log.durationSec ?? Math.max(0, Math.round((Date.now() - log.connectedAt.getTime()) / 1000));
    totalSec += duration;
    const key = dayKey(log.connectedAt);
    byDay.set(key, (byDay.get(key) || 0) + duration);
  }

  // Tiempo realmente JUGANDO (distinto del tiempo conectado de arriba) — ver
  // Room.js _openPlaySession/_closePlaySession.
  const playByDay = new Map();
  let playTotalSec = 0;
  for (const s of playSessions) {
    const duration = s.durationSec ?? Math.max(0, Math.round((Date.now() - s.startedAt.getTime()) / 1000));
    playTotalSec += duration;
    const key = dayKey(s.startedAt);
    playByDay.set(key, (playByDay.get(key) || 0) + duration);
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
    play: {
      totalSec: playTotalSec,
      byDay: [...playByDay.entries()].map(([day, seconds]) => ({ day, seconds })).sort((a, b) => (a.day < b.day ? 1 : -1)),
    },
  });
});
