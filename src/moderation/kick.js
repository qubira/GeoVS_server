import { getIo } from '../socket/ioRegistry.js';
import { getLiveSocketIds } from '../socket/liveUsers.js';

// Expulsa a un usuario del juego AHORA MISMO (todas sus pestañas/conexiones
// abiertas), usado al bloquear su cuenta desde el panel. `User.blocked` ya
// evita que vuelva a loguearse (requireAuth/POST login lo rechazan) — esto
// cubre la sesion que YA tenia abierta, que de otro modo seguiria jugando
// hasta que se desconectara por su cuenta.
export function kickUser(userId, reason) {
  const io = getIo();
  if (!io) return;
  for (const socketId of getLiveSocketIds(userId)) {
    io.to(socketId).emit('account:blocked', { reason });
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
}
