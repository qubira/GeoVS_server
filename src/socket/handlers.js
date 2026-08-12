import { CONFIG } from '../config.js';
import { DEFAULT_LEVEL_ID, listLevels } from '../game/levels.js';

// Registra todos los listeners de socket.io. El servidor es la autoridad: cada
// handler valida el estado de la sala/host antes de aplicar un cambio, nunca
// confia en que el cliente este en el estado que dice estar.
//
// Nota de identidad: los eventos que llegan del cliente solo traen el
// `socket.id` de la conexion actual (implicito en `socket`). Room resuelve
// internamente ese `socket.id` hacia el token estable del jugador
// (ver Room.tokenOf), asi que este archivo nunca necesita saber la diferencia.
export function registerSocketHandlers(io, roomManager) {
  const FACE_STATES = new Set(['neutral', 'happy', 'angry', 'sad']);

  io.on('connection', (socket) => {
    socket.data.name = null;
    socket.data.faceState = 'neutral';

    socket.on('player:identify', ({ name, faceState } = {}, ack) => {
      const clean = String(name || '').trim().slice(0, 16) || `Jugador-${socket.id.slice(0, 4)}`;
      socket.data.name = clean;
      if (FACE_STATES.has(faceState)) socket.data.faceState = faceState;
      ack?.({ ok: true, playerId: socket.id });
    });

    socket.on('levels:list', (_payload, ack) => {
      ack?.({ levels: listLevels() });
    });

    socket.on('room:create', ({ levelId, maxPlayers, mode } = {}, ack) => {
      if (!socket.data.name) return ack?.({ ok: false, error: 'NOT_IDENTIFIED' });
      const room = roomManager.createRoom({
        levelId: levelId || DEFAULT_LEVEL_ID,
        maxPlayers,
        mode,
      });
      const player = room.addPlayer(socket.id, socket.data.name, socket.data.faceState);
      socket.join(room.code);
      roomManager.joinSocketToRoom(socket.id, room.code);
      ack?.({ ok: true, roomCode: room.code, room: room.toDTO(), yourPlayerId: player.id });
    });

    socket.on('room:join', ({ roomCode } = {}, ack) => {
      if (!socket.data.name) return ack?.({ ok: false, error: 'NOT_IDENTIFIED' });
      const room = roomManager.getRoom(String(roomCode || '').toUpperCase());
      if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
      if (room.state !== 'lobby') return ack?.({ ok: false, error: 'ALREADY_STARTED' });
      if (room.isFull()) return ack?.({ ok: false, error: 'ROOM_FULL' });

      const player = room.addPlayer(socket.id, socket.data.name, socket.data.faceState);
      socket.join(room.code);
      roomManager.joinSocketToRoom(socket.id, room.code);
      socket.to(room.code).emit('room:playerJoined', { player: room.playerLobbyDTO(player) });
      ack?.({ ok: true, room: room.toDTO(), yourPlayerId: player.id });
    });

    // Reconexion: el cliente guardo {roomCode, token} de una sala a la que ya
    // pertenecia (ver client/src/network/session.js) y los reenvia apenas el
    // socket vuelve a conectar (reconexion de socket.io o reinicio de la app).
    // Si el token es valido, recupera el MISMO jugador (mismo color, progreso,
    // lugar en el leaderboard) en vez de crear uno nuevo.
    socket.on('room:rejoin', ({ roomCode, token } = {}, ack) => {
      const room = roomManager.getRoom(String(roomCode || '').toUpperCase());
      if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
      const player = room.rejoinPlayer(socket.id, token);
      if (!player) return ack?.({ ok: false, error: 'TOKEN_NOT_FOUND' });

      socket.data.name = player.name;
      socket.join(room.code);
      roomManager.joinSocketToRoom(socket.id, room.code);
      io.to(room.code).emit('room:playerUpdated', { playerId: player.id, patch: { connected: true } });

      const response = { ok: true, room: room.toDTO(), yourPlayerId: player.id };
      if (room.state === 'playing' && room.level) {
        response.gameStart = {
          levelId: room.levelId,
          levelData: room.level,
          mode: room.mode,
          tickRate: CONFIG.TICK_RATE_HZ,
          serverStartTime: room.roundStartTime,
        };
      }
      ack?.(response);
    });

    socket.on('room:leave', (_payload, ack) => {
      handleLeave(io, roomManager, socket);
      ack?.({ ok: true });
    });

    socket.on('room:setReady', ({ ready } = {}) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room || room.state !== 'lobby') return;
      const playerId = room.setReady(socket.id, ready);
      if (playerId) io.to(room.code).emit('room:playerUpdated', { playerId, patch: { ready: !!ready } });
    });

    socket.on('room:setLevel', ({ levelId } = {}) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room) return;
      if (room.setLevel(socket.id, levelId)) {
        io.to(room.code).emit('room:updated', { room: room.toDTO() });
      }
    });

    socket.on('room:setMode', ({ mode } = {}) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room) return;
      if (room.setMode(socket.id, mode)) {
        io.to(room.code).emit('room:updated', { room: room.toDTO() });
      }
    });

    socket.on('room:startGame', ({ force } = {}, ack) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room) return ack?.({ ok: false, error: 'NO_ROOM' });
      if (!room.isHost(socket.id)) return ack?.({ ok: false, error: 'NOT_HOST' });
      if (room.state !== 'lobby') return ack?.({ ok: false, error: 'INVALID_STATE' });
      const connectedCount = [...room.players.values()].filter((p) => p.connected).length;
      if (connectedCount < room.minPlayersToStart) return ack?.({ ok: false, error: 'NOT_ENOUGH_PLAYERS' });
      if (!force && !room.canStart()) return ack?.({ ok: false, error: 'NOT_ALL_READY' });
      room.startCountdown();
      ack?.({ ok: true });
    });

    socket.on('room:playAgain', (_payload, ack) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room) return ack?.({ ok: false, error: 'NO_ROOM' });
      const success = room.playAgain(socket.id);
      ack?.({ ok: success });
    });

    socket.on('game:input', ({ jumpHeld } = {}) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      if (!room || room.state !== 'playing') return;
      room.handleInput(socket.id, { jumpHeld });
    });

    socket.on('chat:message', ({ text } = {}) => {
      const room = roomManager.getRoomOfSocket(socket.id);
      const player = room?.getPlayerBySocket(socket.id);
      if (!room || !player || !text) return;
      const clean = String(text).slice(0, 200);
      io.to(room.code).emit('chat:message', { playerId: player.id, name: player.name, text: clean, ts: Date.now() });
    });

    socket.on('disconnect', () => {
      handleLeave(io, roomManager, socket);
    });
  });
}

function handleLeave(io, roomManager, socket) {
  const room = roomManager.getRoomOfSocket(socket.id);
  if (!room) return;

  if (room.state === 'playing') {
    // Partida en curso: no se borra al jugador (rompería el leaderboard), solo
    // se congela su cubo en su ultima posicion y se marca "desconectado".
    // Puede reconectar mas tarde via room:rejoin y recuperar el mismo cubo.
    const { newHostId, playerId } = room.markDisconnected(socket.id);
    if (playerId) {
      io.to(room.code).emit('room:playerUpdated', { playerId, patch: { connected: false } });
      io.to(room.code).emit('room:playerDisconnected', { playerId });
    }
    if (newHostId) io.to(room.code).emit('room:hostChanged', { newHostId });
    roomManager.removeSocket(socket.id);
    socket.leave(room.code);
    return;
  }

  // Lobby / countdown / finished: sin ronda activa que preservar, se remueve del todo.
  const { removed, newHostId, playerId } = room.removePlayer(socket.id);
  if (removed) {
    socket.leave(room.code);
    io.to(room.code).emit('room:playerLeft', { playerId });
    if (newHostId) io.to(room.code).emit('room:hostChanged', { newHostId });
  }
  roomManager.removeSocket(socket.id);
  roomManager.disposeIfEmpty(room);
}
