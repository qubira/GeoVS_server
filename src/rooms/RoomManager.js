import { Room } from './Room.js';
import { generateRoomCode } from '../utils/roomCode.js';
import { prisma } from '../db.js';

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
    this.socketToRoom = new Map(); // socketId -> roomCode
  }

  createRoom({ levelId, maxPlayers, mode }) {
    let code;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, this.io, { levelId, maxPlayers, mode });
    this.rooms.set(code, room);

    // Registro para el modulo "Salas" del panel — no bloquea la creacion de
    // la sala (fire-and-forget, mismo patron que _openPlaySession en
    // Room.js); si falla, la sala sigue funcionando, solo no queda
    // registrada en el historico.
    prisma.roomLog
      .create({ data: { code, mode: room.mode, levelId: room.levelId, maxPlayers: room.maxPlayers } })
      .then((log) => {
        room.roomLogId = log.id;
      })
      .catch((err) => console.error('Error creando room log:', err));

    return room;
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  getRoomOfSocket(socketId) {
    const code = this.socketToRoom.get(socketId);
    return code ? this.getRoom(code) : null;
  }

  joinSocketToRoom(socketId, roomCode) {
    this.socketToRoom.set(socketId, roomCode);
  }

  removeSocket(socketId) {
    this.socketToRoom.delete(socketId);
  }

  // Listado publico de todas las salas vivas (cualquier estado), para la
  // pantalla de "salas activas" del cliente. No filtra por unibles: el
  // cliente decide que mostrar/habilitar segun `state`/`maxPlayers`.
  listRooms() {
    return [...this.rooms.values()]
      .sort((a, b) => b.players.size - a.players.size)
      .map((room) => room.summaryDTO());
  }

  // Elimina la sala si quedo vacia (limpia el intervalo del countdown/gameloop
  // para no dejar timers huerfanos corriendo en el proceso).
  disposeIfEmpty(room) {
    if (room.isEmpty()) {
      room.destroy();
      this.rooms.delete(room.code);
      if (room.roomLogId) {
        prisma.roomLog
          .update({ where: { id: room.roomLogId }, data: { endedAt: new Date(), endReason: 'emptied' } })
          .catch((err) => console.error('Error cerrando room log:', err));
      }
    }
  }

  // "Finalizar sala" desde el panel: expulsa a TODOS los jugadores ahora
  // mismo y destruye la sala de una — NO se puede dejar que el flujo normal
  // de desconexion se encargue solo: si la sala esta en 'playing',
  // handleLeave (handlers.js) NUNCA llama a disposeIfEmpty ahi (solo marca
  // "desconectado" para permitir reconectar a media partida), asi que la
  // sala quedaria viva para siempre. Por eso el teardown se hace directo
  // aca, y se limpia `socketToRoom` ANTES de desconectar cada socket para
  // que el handler de 'disconnect' que dispara despues no encuentre la sala
  // (ya no existe) y no intente nada mas sobre ella.
  endRoomByAdmin(code, adminUsername) {
    const room = this.rooms.get(code);
    if (!room) return false;

    room.roomChannel.emit('room:endedByAdmin', { reason: 'Un administrador finalizó esta sala.' });

    for (const socketId of [...room.socketToToken.keys()]) {
      this.socketToRoom.delete(socketId);
      const socket = this.io.sockets.sockets.get(socketId);
      socket?.leave(room.code);
      socket?.disconnect(true);
    }

    room.destroy();
    this.rooms.delete(room.code);
    if (room.roomLogId) {
      prisma.roomLog
        .update({ where: { id: room.roomLogId }, data: { endedAt: new Date(), endReason: 'admin', endedBy: adminUsername } })
        .catch((err) => console.error('Error cerrando room log (finalizada por admin):', err));
    }
    return true;
  }
}
