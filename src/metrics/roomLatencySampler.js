import { prisma } from '../db.js';
import { getIo } from '../socket/ioRegistry.js';

const SAMPLE_INTERVAL_MS = 20000;

// Cada ~20s, para cada sala VIVA con jugadores, guarda una foto agregada de
// la latencia (promedio/min/max entre los jugadores conectados en ese
// momento) y actualiza el pico de jugadores — esto es lo que arma el
// historico/grafico de lineas por sala en el panel.
export function startRoomLatencySampler(roomManager) {
  const interval = setInterval(async () => {
    const io = getIo();
    if (!io) return;

    for (const room of roomManager.rooms.values()) {
      if (!room.roomLogId || room.players.size === 0) continue;

      const rtts = [];
      for (const socketId of room.socketToToken.keys()) {
        const rtt = io.sockets.sockets.get(socketId)?.data?.lastRttMs;
        if (rtt != null) rtts.push(rtt);
      }
      const playerCount = room.players.size;
      const avgRttMs = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
      const minRttMs = rtts.length ? Math.min(...rtts) : null;
      const maxRttMs = rtts.length ? Math.max(...rtts) : null;

      try {
        await prisma.roomLatencySample.create({
          data: { roomLogId: room.roomLogId, avgRttMs, minRttMs, maxRttMs, playerCount },
        });
        await prisma.roomLog.updateMany({
          where: { id: room.roomLogId, peakPlayers: { lt: playerCount } },
          data: { peakPlayers: playerCount },
        });
      } catch (err) {
        console.error('Error guardando muestra de latencia de sala:', err);
      }
    }
  }, SAMPLE_INTERVAL_MS);
  return () => clearInterval(interval);
}
