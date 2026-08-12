import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { RoomManager } from './rooms/RoomManager.js';
import { registerSocketHandlers } from './socket/handlers.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }, // demo local: abierto a cualquier origen
});

const roomManager = new RoomManager(io);
registerSocketHandlers(io, roomManager);

httpServer.listen(PORT, () => {
  console.log(`Servidor Geometry Dash Multi escuchando en http://localhost:${PORT}`);
});
