import { Room } from './Room.js';
import { generateRoomCode } from '../utils/roomCode.js';

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

  // Elimina la sala si quedo vacia (limpia el intervalo del countdown/gameloop
  // para no dejar timers huerfanos corriendo en el proceso).
  disposeIfEmpty(room) {
    if (room.isEmpty()) {
      room.destroy();
      this.rooms.delete(room.code);
    }
  }
}
