import { randomUUID } from 'node:crypto';
import { CONFIG, PHYSICS } from '../config.js';
import { stepPlayer, makeInitialPlayerState } from '../game/PhysicsEngine.js';
import { getLevel } from '../game/levels.js';
import { GameLoop } from '../game/GameLoop.js';
import { prisma } from '../db.js';

// Punto de reaparicion mas avanzado que el jugador ya cruzo. Los checkpoints
// de cada nivel (level.checkpoints) se definen a mano en el diseño del nivel,
// SIEMPRE justo despues de superar un grupo de obstaculos y antes de la
// pista libre hacia el siguiente, para garantizar que reaparecer ahi deje
// tiempo real de reaccion (ver server/src/levels/*.json).
function checkpointFor(x, level) {
  const checkpoints = level?.checkpoints || [0];
  let result = checkpoints[0];
  for (const cp of checkpoints) {
    if (cp > x) break;
    result = cp;
  }
  return result;
}

// Una Room encapsula TODO el estado autoritativo de una partida: los jugadores,
// el nivel, el modo, y el bucle de simulacion. El cliente nunca decide nada de
// esto directamente, solo lo consulta (via eventos) o le manda inputs.
//
// Identidad: `player.id` es un TOKEN estable (UUID) que identifica al jugador
// durante toda la vida de la sala, independiente de su conexion de socket.io
// (el `socket.id` cambia cada vez que el celular pierde y recupera la
// conexion). `socketToToken` mapea la conexion ACTUAL de cada jugador hacia su
// token; es lo unico que se resuelve a partir de un `socket.id` entrante. Esto
// es lo que permite reconectar (room:rejoin) sin que el jugador cambie de
// identidad en el leaderboard de los demas.
export class Room {
  constructor(code, io, { levelId, maxPlayers, mode }) {
    this.code = code;
    this.io = io;
    this.hostId = null; // token del host
    this.levelId = levelId;
    // maxPlayers=1 habilita una sala "practica solo": no hace falta esperar a
    // nadie mas para iniciar. maxPlayers>=2 sigue exigiendo CONFIG.MIN_PLAYERS
    // jugadores conectados para arrancar, como una sala multijugador normal.
    this.maxPlayers = Math.max(1, Math.min(maxPlayers || CONFIG.MAX_PLAYERS, CONFIG.MAX_PLAYERS));
    this.minPlayersToStart = this.maxPlayers === 1 ? 1 : CONFIG.MIN_PLAYERS;
    this.mode = mode || CONFIG.MODE;
    this.state = 'lobby'; // 'lobby' | 'countdown' | 'playing' | 'finished'

    this.players = new Map(); // token -> playerState (lobby + fisica)
    this.inputs = new Map(); // token -> { jumpHeld }
    this.socketToToken = new Map(); // socket.id (conexion actual) -> token

    this.level = null;
    this.roundStartTime = null;
    this.winnerAt = null; // timestamp del primer finisher (arranca el "grace period")
    this.loop = null;
    this.countdownInterval = null;
  }

  get roomChannel() {
    return this.io.to(this.code);
  }

  isEmpty() {
    return this.players.size === 0;
  }

  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  // Resuelve la conexion actual (socket.id) hacia la identidad estable (token).
  tokenOf(socketId) {
    return this.socketToToken.get(socketId) || null;
  }

  getPlayerBySocket(socketId) {
    const token = this.tokenOf(socketId);
    return token ? this.players.get(token) : null;
  }

  isHost(socketId) {
    const token = this.tokenOf(socketId);
    return !!token && token === this.hostId;
  }

  addPlayer(socketId, name, faceState, country, countryCode, role, userId) {
    const token = randomUUID();
    const color = CONFIG.PLAYER_COLORS[this.players.size % CONFIG.PLAYER_COLORS.length];
    const player = {
      id: token,
      name: (name || 'Jugador').slice(0, 16),
      color,
      // Expresion de avatar elegida por el jugador (ver client web
      // src/components/AvatarCreator.tsx). Opcional: clientes que no la
      // manden (p. ej. la app movil) quedan con la cara neutral por defecto.
      faceState: faceState || 'neutral',
      // Pais resuelto por IP en el momento de identificarse (ver
      // socket/handlers.js + utils/geoip.js). null si no se pudo resolver
      // (IP local/privada, o la consulta fallo).
      country: country || null,
      countryCode: countryCode || null,
      // Rol de la cuenta (player/developer/moderator/admin). null si es una
      // sesion anonima (sin cuenta, p. ej. la app movil todavia sin login).
      role: role || null,
      // Id de cuenta autenticada (null = sesion anonima). Se usa para abrir
      // PlaySession al empezar a jugar (ver startGame/_openPlaySession mas
      // abajo) — sin cuenta no hay a quien atribuirle la metrica.
      userId: userId || null,
      // Promesa del PlaySession abierto mientras este jugador esta jugando
      // activamente esta ronda (null si no esta jugando o no tiene cuenta).
      playSessionOpen: null,
      ready: false,
      connected: true,
      ...makeInitialPlayerState(),
    };
    this.players.set(token, player);
    this.inputs.set(token, { jumpHeld: false });
    this.socketToToken.set(socketId, token);
    if (!this.hostId) this.hostId = token;
    return player;
  }

  // Reengancha una conexion nueva (socket.id) a un jugador ya existente por su
  // token estable. Se usa cuando un celular pierde la red y socket.io reconecta
  // con una conexion nueva; el jugador conserva su progreso, color y lugar en
  // el leaderboard porque su `player.id` (token) no cambia.
  rejoinPlayer(socketId, token) {
    const player = this.players.get(token);
    if (!player) return null;
    player.connected = true;
    this.socketToToken.set(socketId, token);
    // Si reconecta a media partida (p. ej. perdio señal y volvio), reabre su
    // PlaySession: la desconexion ya cerro la anterior (markDisconnected), asi
    // que el tiempo desconectado queda excluido de las metricas de juego.
    if (this.state === 'playing' && player.userId && !player.playSessionOpen) {
      this._openPlaySession(player);
    }
    return player;
  }

  // Devuelve { removed, newHostId, playerId } para que el caller decida que emitir.
  removePlayer(socketId) {
    const token = this.tokenOf(socketId);
    if (!token) return { removed: false, newHostId: null, playerId: null };
    this.players.delete(token);
    this.inputs.delete(token);
    this.socketToToken.delete(socketId);
    let newHostId = null;
    if (this.hostId === token) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
      newHostId = this.hostId;
    }
    return { removed: true, newHostId, playerId: token };
  }

  // Durante una partida en curso no removemos al jugador (rompería su carril del
  // leaderboard); solo lo marcamos desconectado y su cubo se congela en su
  // ultima posicion conocida, hasta que reconecte (rejoinPlayer) o termine la ronda.
  markDisconnected(socketId) {
    const token = this.tokenOf(socketId);
    if (!token) return { newHostId: null, playerId: null };
    const player = this.players.get(token);
    if (player) {
      player.connected = false;
      if (this.state === 'playing') this._closePlaySession(player, 'disconnected');
    }
    this.socketToToken.delete(socketId);
    let newHostId = null;
    if (this.hostId === token) {
      const next = [...this.players.values()].find((p) => p.connected && p.id !== token);
      this.hostId = next ? next.id : null;
      newHostId = this.hostId;
    }
    return { newHostId, playerId: token };
  }

  // Devuelve el token del jugador afectado (o null) para que el caller emita
  // room:playerUpdated con la identidad correcta.
  setReady(socketId, ready) {
    const player = this.getPlayerBySocket(socketId);
    if (!player) return null;
    player.ready = !!ready;
    return player.id;
  }

  setLevel(socketId, levelId) {
    if (!this.isHost(socketId) || this.state !== 'lobby') return false;
    if (!getLevel(levelId)) return false;
    this.levelId = levelId;
    return true;
  }

  setMode(socketId, mode) {
    if (!this.isHost(socketId) || this.state !== 'lobby') return false;
    if (mode !== 'race' && mode !== 'elimination') return false;
    this.mode = mode;
    return true;
  }

  canStart() {
    const connectedPlayers = [...this.players.values()].filter((p) => p.connected);
    return connectedPlayers.length >= this.minPlayersToStart && connectedPlayers.every((p) => p.ready);
  }

  handleInput(socketId, input) {
    const token = this.tokenOf(socketId);
    if (!token || !this.inputs.has(token)) return;
    this.inputs.set(token, { jumpHeld: !!input.jumpHeld });
  }

  // --- Ciclo de vida de la partida ---

  startCountdown() {
    if (this.state !== 'lobby') return;
    this.state = 'countdown';
    let secondsLeft = CONFIG.COUNTDOWN_SECONDS;
    this.roomChannel.emit('room:countdown', { secondsLeft });
    this.countdownInterval = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
        this.startGame();
        return;
      }
      this.roomChannel.emit('room:countdown', { secondsLeft });
    }, 1000);
  }

  startGame() {
    this.level = getLevel(this.levelId);
    for (const player of this.players.values()) {
      Object.assign(player, makeInitialPlayerState());
    }
    this.winnerAt = null;
    this.state = 'playing';
    this.roundStartTime = Date.now();

    for (const player of this.players.values()) {
      if (player.connected && player.userId) this._openPlaySession(player);
    }

    this.roomChannel.emit('game:start', {
      levelId: this.levelId,
      levelData: this.level,
      mode: this.mode,
      tickRate: CONFIG.TICK_RATE_HZ,
      serverStartTime: this.roundStartTime,
    });

    this.loop = new GameLoop({
      tickRateHz: CONFIG.TICK_RATE_HZ,
      broadcastRateHz: CONFIG.BROADCAST_RATE_HZ,
      onTick: (dt) => this.tick(dt),
      onBroadcast: () => this.broadcastState(),
    });
    this.loop.start();
  }

  // --- Metricas: sesiones de juego activo ---
  //
  // Distinta de ConnectionLog (conexion de socket, puede incluir tiempo en
  // menus/lobby): esto solo cubre el tramo en que el jugador esta realmente
  // jugando una ronda (state === 'playing'). No se awaitea nunca desde tick()
  // ni desde sus callers (ver comentario en tick()) para no introducir
  // reentrancia en el loop de 60Hz; la promesa de apertura se guarda en
  // `player.playSessionOpen` y el cierre se encadena sobre ella con `.then()`.

  _openPlaySession(player) {
    player.playSessionOpen = prisma.playSession
      .create({
        data: {
          userId: player.userId,
          levelId: this.levelId,
          roomCode: this.code,
          country: player.country,
          countryCode: player.countryCode,
        },
      })
      .catch((err) => {
        console.error('Error abriendo play session:', err);
        return null;
      });
  }

  _closePlaySession(player, endReason) {
    if (!player.playSessionOpen) return;
    const openPromise = player.playSessionOpen;
    player.playSessionOpen = null; // evita doble cierre si dos hooks disparan para el mismo jugador
    openPromise
      .then((session) => {
        if (!session) return; // la creacion fallo o no habia cuenta
        const endedAt = new Date();
        const durationSec = Math.max(0, Math.round((endedAt - session.startedAt) / 1000));
        return prisma.playSession.update({ where: { id: session.id }, data: { endedAt, durationSec, endReason } });
      })
      .catch((err) => console.error('Error cerrando play session:', err));
  }

  tick(dt) {
    const now = Date.now();

    for (const player of this.players.values()) {
      if (!player.connected) continue;

      // Reaparicion (modo carrera) una vez pasado el delay de respawn
      if (!player.alive && !player.eliminated && !player.finished && player.respawnAt && now >= player.respawnAt) {
        player.x = CONFIG.RESPAWN_MODE === 'checkpoint' ? player.checkpointX : 0;
        player.y = PHYSICS.GROUND_Y - PHYSICS.PLAYER_SIZE;
        player.vy = 0;
        player.grounded = true;
        player.alive = true;
        player.respawnAt = null;
      }

      const input = this.inputs.get(player.id) || { jumpHeld: false };
      const events = stepPlayer(player, input, dt, this.level);

      for (const event of events) {
        if (event.type === 'death') {
          this.onPlayerDeath(player);
        } else if (event.type === 'finished') {
          this.onPlayerFinished(player, now);
        }
      }

      if (player.alive) {
        player.checkpointX = Math.max(player.checkpointX, checkpointFor(player.x, this.level));
      }
    }

    this.checkRoundEnd(now);
  }

  onPlayerDeath(player) {
    if (this.mode === 'elimination') {
      player.eliminated = true;
      this._closePlaySession(player, 'eliminated');
      this.roomChannel.emit('game:playerEliminated', { playerId: player.id });
      return;
    }
    // modo race: programa reaparicion (el jugador sigue jugando, no se cierra
    // la play session)
    player.respawnAt = Date.now() + CONFIG.RESPAWN_DELAY_MS;
    this.roomChannel.emit('game:playerDied', { playerId: player.id, respawnAt: player.respawnAt });
  }

  onPlayerFinished(player, now) {
    const place = [...this.players.values()].filter((p) => p.finished).length; // ya se marco finished antes de esto
    player.finishTime = now - this.roundStartTime;
    if (this.winnerAt === null) this.winnerAt = now;
    this._closePlaySession(player, 'finished');
    this.roomChannel.emit('game:playerFinished', { playerId: player.id, time: player.finishTime, place });
  }

  checkRoundEnd(now) {
    if (this.state !== 'playing') return;

    const elapsed = now - this.roundStartTime;
    if (elapsed >= CONFIG.ROUND_TIMEOUT_MS) {
      this.endRound('timeout');
      return;
    }

    const connectedPlayers = [...this.players.values()].filter((p) => p.connected);

    if (this.mode === 'elimination') {
      const allDone = connectedPlayers.every((p) => p.eliminated || p.finished);
      if (allDone) {
        this.endRound('allDeadOrEliminated');
      }
      return;
    }

    // modo race
    const allFinished = connectedPlayers.every((p) => p.finished);
    if (allFinished) {
      this.endRound('allFinished');
      return;
    }
    if (this.winnerAt !== null && now - this.winnerAt >= CONFIG.POST_WIN_GRACE_MS) {
      this.endRound('allFinished');
    }
  }

  endRound(reason) {
    if (this.loop) {
      this.loop.stop();
      this.loop = null;
    }
    this.state = 'finished';

    // Cualquiera que siga "in-progress" (ronda termino por timeout u otro
    // motivo mientras seguia jugando) necesita que se le cierre la play
    // session aqui; los ya 'disconnected' ya se cerraron en markDisconnected.
    for (const p of this.players.values()) {
      const status = p.finished ? 'finished' : p.eliminated ? 'eliminated' : p.connected ? 'in-progress' : 'disconnected';
      if (status === 'in-progress') this._closePlaySession(p, 'round-ended');
    }

    const results = [...this.players.values()]
      .map((p) => ({
        playerId: p.id,
        name: p.name,
        progress: Math.round(p.progress),
        time: p.finishTime,
        status: p.finished ? 'finished' : p.eliminated ? 'eliminated' : p.connected ? 'in-progress' : 'disconnected',
      }))
      .sort((a, b) => {
        if (a.status === 'finished' && b.status === 'finished') return a.time - b.time;
        if (a.status === 'finished') return -1;
        if (b.status === 'finished') return 1;
        return b.progress - a.progress;
      })
      .map((r, index) => ({ ...r, place: index + 1 }));

    this.roomChannel.emit('game:roundEnded', { reason, results });
  }

  playAgain(socketId) {
    if (!this.isHost(socketId) || this.state !== 'finished') return false;
    for (const player of this.players.values()) {
      player.ready = false;
      Object.assign(player, makeInitialPlayerState());
    }
    this.state = 'lobby';
    this.roomChannel.emit('room:backToLobby', { room: this.toDTO() });
    return true;
  }

  destroy() {
    if (this.loop) this.loop.stop();
    if (this.countdownInterval) clearInterval(this.countdownInterval);
  }

  // --- Serializacion para el cliente ---

  playerLobbyDTO(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      faceState: p.faceState || 'neutral',
      country: p.country || null,
      countryCode: p.countryCode || null,
      role: p.role || null,
      ready: p.ready,
      connected: p.connected,
    };
  }

  // Resumen liviano para el listado publico de salas (ver rooms:list) — no
  // expone posiciones/estado de partida, solo lo necesario para elegir una
  // sala a la que unirse.
  summaryDTO() {
    return {
      code: this.code,
      mode: this.mode,
      levelId: this.levelId,
      state: this.state,
      maxPlayers: this.maxPlayers,
      players: [...this.players.values()].map((p) => this.playerLobbyDTO(p)),
    };
  }

  toDTO() {
    return {
      code: this.code,
      hostId: this.hostId,
      levelId: this.levelId,
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      state: this.state,
      players: [...this.players.values()].map((p) => this.playerLobbyDTO(p)),
    };
  }

  broadcastState() {
    if (this.state !== 'playing') return;
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      vy: Math.round(p.vy),
      alive: p.alive,
      eliminated: p.eliminated,
      finished: p.finished,
      progress: p.progress,
      connected: p.connected,
    }));
    this.roomChannel.emit('game:state', { serverTime: Date.now(), players });
  }
}
