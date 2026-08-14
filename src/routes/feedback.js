import { Router } from 'express';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';

// Endpoint publico (solo requiere estar logueado) para que un jugador deje
// un comentario/sugerencia desde el juego (ver ProfileModal.tsx) — no es
// parte de /admin, lo lee el panel via /admin/feedback (ver admin.js).
export const feedbackRouter = Router();

feedbackRouter.post('/', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'INVALID_TEXT' });

  const comment = await prisma.comment.create({
    data: { userId: req.user.id, username: req.user.username, text },
  });
  res.status(201).json({ ok: true, comment });
});
