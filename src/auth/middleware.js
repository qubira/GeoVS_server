import { verifyToken } from './tokens.js';
import { prisma } from '../db.js';

// Exige un token valido (Authorization: Bearer <token>) y adjunta el usuario
// autenticado (fresco desde la base, no solo lo que dice el token) en
// req.user. Rechaza cuentas bloqueadas.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'INVALID_TOKEN' });

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });
  if (user.blocked) return res.status(403).json({ error: 'ACCOUNT_BLOCKED' });

  req.user = user;
  next();
}
