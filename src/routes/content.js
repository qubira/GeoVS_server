import { Router } from 'express';
import { prisma } from '../db.js';

// Rutas publicas (sin requireAuth): contenido creado desde el panel que
// necesitan ver jugadores normales, no solo admins — hoy solo la lista de
// avatares personalizados, que el creador de avatar del juego (GeoVS_juego)
// consume para ofrecerlos como opcion junto a las 4 caras integradas.
export const contentRouter = Router();

contentRouter.get('/custom-avatars', async (_req, res) => {
  // Solo los publicados — un avatar recien subido queda en borrador hasta
  // que el admin lo publica explicitamente (ver CustomAvatar.published).
  const avatars = await prisma.customAvatar.findMany({ where: { published: true }, orderBy: { createdAt: 'desc' } });
  res.json({
    ok: true,
    avatars: avatars.map((a) => ({ id: a.id, name: a.name, imageUrl: a.imageUrl, kind: a.kind })),
  });
});
