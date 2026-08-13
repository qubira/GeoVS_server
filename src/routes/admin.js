import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { logAudit, logAuditMany } from '../auth/audit.js';
import { listLevels, syncCustomLevelInMemory, removeCustomLevelFromMemory } from '../game/levels.js';
import { PHYSICS } from '../config.js';
import { uploadBuffer } from '../utils/cloudinary.js';
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

// --- Modulo "Crear": avatares, objetos y niveles personalizados ---------

const ALLOWED_UPLOAD_KINDS = {
  avatar: /^image\//,
  object: /^image\//,
  background: /^image\//,
  music: /^audio\//,
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

adminRouter.post('/uploads', upload.single('file'), async (req, res) => {
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
  const obstacles = Array.isArray(body?.obstacles) ? body.obstacles : null;
  const checkpoints = Array.isArray(body?.checkpoints) ? body.checkpoints : [0];

  if (!name) return { error: 'INVALID_NAME' };
  if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 600) return { error: 'INVALID_DURATION' };
  if (speedX !== null && (!Number.isFinite(speedX) || speedX < 100 || speedX > 1200)) return { error: 'INVALID_SPEED' };
  if (jumpVelocity !== null && (!Number.isFinite(jumpVelocity) || jumpVelocity > -300 || jumpVelocity < -2000)) return { error: 'INVALID_JUMP' };
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
      musicUrl: body?.musicUrl ? String(body.musicUrl).trim() : null,
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
