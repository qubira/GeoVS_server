// Mide la latencia REAL (ping/RTT) de cada socket conectado contra el
// servidor — no hay forma de leer el ancho de banda real (subida/bajada) de
// la maquina desde dentro de la app en Render, asi que esta es la metrica
// de "que tan bien anda la conexion" que se puede medir de verdad, en vivo,
// por jugador. Usa el mecanismo de ack-con-timeout de Socket.IO: el cliente
// solo necesita reenviar el callback que le llega (ver SocketClient.ts,
// `socket.on('ping:check', (cb) => cb?.())`), no manda ningun dato propio —
// asi el valor lo calcula y controla el servidor, no algo que el cliente
// pueda falsear.
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 4000;

export function startLatencyProbe(io) {
  const interval = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      const start = Date.now();
      socket.timeout(PING_TIMEOUT_MS).emit('ping:check', (err) => {
        socket.data.lastRttMs = err ? null : Date.now() - start;
      });
    }
  }, PING_INTERVAL_MS);
  return () => clearInterval(interval);
}

// Umbrales en ms — juicio propio, no un estandar formal, pero razonable
// para un juego de reflejos en tiempo real como este.
const QUALITY_THRESHOLDS = { muy_buena: 80, normal: 180, baja: 350 };

export function classifyRtt(rttMs) {
  if (rttMs == null) return 'mala';
  if (rttMs <= QUALITY_THRESHOLDS.muy_buena) return 'muy_buena';
  if (rttMs <= QUALITY_THRESHOLDS.normal) return 'normal';
  if (rttMs <= QUALITY_THRESHOLDS.baja) return 'baja';
  return 'mala';
}
