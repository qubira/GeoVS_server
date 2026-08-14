import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { RoomManager } from './rooms/RoomManager.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { setIo, setRoomManager } from './socket/ioRegistry.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { contentRouter } from './routes/content.js';
import { loadCustomLevelsFromDb } from './game/levels.js';
import { startLatencyProbe } from './metrics/latency.js';
import { startRoomLatencySampler } from './metrics/roomLatencySampler.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/content', contentRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }, // demo local: abierto a cualquier origen
});

setIo(io);
const roomManager = new RoomManager(io);
setRoomManager(roomManager);
registerSocketHandlers(io, roomManager);

// Modulo "Salas" del panel: latencia real por jugador + historico por sala.
startLatencyProbe(io);
startRoomLatencySampler(roomManager);

// Pistas creadas desde el panel (ver game/levels.js) — se cargan antes de
// aceptar conexiones para que esten disponibles desde el primer room:create.
await loadCustomLevelsFromDb();

httpServer.listen(PORT, () => {
  console.log(`Servidor Geometry Dash Multi escuchando en http://localhost:${PORT}`);
});
