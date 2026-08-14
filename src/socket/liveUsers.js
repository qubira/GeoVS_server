// Registro de sockets conectados AHORA MISMO por cuenta (userId). No existia
// ningun mapeo userId -> socket.id en el proyecto (Room.js resuelve al reves,
// socket.id -> token del jugador DENTRO de una sala, pero eso no cubre a
// alguien que esta conectado sin estar en ninguna sala, ni permite ubicarlo
// por su id de cuenta). Un mismo usuario puede tener varias pestañas/sockets
// abiertos a la vez, por eso cada entrada es un Set.
const socketsByUserId = new Map();

export function registerLiveSocket(userId, socketId) {
  if (!userId) return;
  const set = socketsByUserId.get(userId) || new Set();
  set.add(socketId);
  socketsByUserId.set(userId, set);
}

export function unregisterLiveSocket(userId, socketId) {
  if (!userId) return;
  const set = socketsByUserId.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) socketsByUserId.delete(userId);
}

export function getLiveSocketIds(userId) {
  return [...(socketsByUserId.get(userId) || [])];
}
