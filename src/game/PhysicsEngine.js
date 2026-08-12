import { PHYSICS } from '../config.js';

const { GRAVITY, JUMP_VELOCITY, MAX_FALL_SPEED, SPEED_X, PLAYER_SIZE, GROUND_Y } = PHYSICS;

// Resuelve la colision de un jugador contra UN obstaculo (AABB).
// prevBottom: borde inferior del jugador ANTES de moverse este tick, se usa
// para distinguir "aterrizar encima" (seguro) de "chocar de lado" (muerte).
function resolveObstacle(player, obstacle, prevBottom) {
  const left = player.x;
  const right = player.x + PLAYER_SIZE;
  const top = player.y;
  const bottom = player.y + PLAYER_SIZE;
  const obsLeft = obstacle.x;
  const obsRight = obstacle.x + obstacle.w;
  const obsTop = obstacle.y;
  const obsBottom = obstacle.y + obstacle.h;

  const overlaps = right > obsLeft && left < obsRight && bottom > obsTop && top < obsBottom;
  if (!overlaps) return null;

  if (obstacle.type === 'spike') {
    return { type: 'death' };
  }

  // block / platform: solo es seguro si el jugador caia y estaba por encima
  const wasAbove = prevBottom <= obsTop + 1 && player.vy >= 0;
  if (wasAbove) {
    return { type: 'land', landY: obsTop - PLAYER_SIZE };
  }
  if (obstacle.type === 'block') {
    return { type: 'death' };
  }
  return null; // plataforma tocada de lado/abajo: se ignora (no solida ahi)
}

// Avanza la simulacion de UN jugador un paso (dt en segundos).
// `input` = { jumpHeld: boolean } tal como lo mando el cliente.
// `level` = { length, obstacles }
// Devuelve el propio `player` mutado, mas info de eventos ocurridos en este tick.
export function stepPlayer(player, input, dt, level) {
  const events = [];

  if (!player.alive || player.finished || player.eliminated) {
    return events;
  }

  const prevBottom = player.y + PLAYER_SIZE;

  // Avance horizontal constante (estilo Geometry Dash: la camara/nivel corre solo)
  player.x += SPEED_X * dt;

  // Gravedad y salto
  player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL_SPEED);
  if (input.jumpHeld && player.grounded) {
    player.vy = JUMP_VELOCITY;
    player.grounded = false;
  }
  player.y += player.vy * dt;

  // Colision con el suelo
  player.grounded = false;
  if (player.y + PLAYER_SIZE >= GROUND_Y) {
    player.y = GROUND_Y - PLAYER_SIZE;
    player.vy = 0;
    player.grounded = true;
  }

  // Colision con obstaculos del nivel (solo los cercanos en X, por rendimiento)
  for (const obstacle of level.obstacles) {
    if (obstacle.x + obstacle.w < player.x - 50 || obstacle.x > player.x + PLAYER_SIZE + 50) {
      continue;
    }
    const result = resolveObstacle(player, obstacle, prevBottom);
    if (!result) continue;
    if (result.type === 'death') {
      player.alive = false;
      events.push({ type: 'death', x: player.x });
      break;
    }
    if (result.type === 'land') {
      player.y = result.landY;
      player.vy = 0;
      player.grounded = true;
    }
  }

  // Progreso y checkpoints (solo mientras vivo)
  if (player.alive) {
    player.progress = Math.max(0, Math.min(100, (player.x / level.length) * 100));
    if (player.x >= level.length) {
      player.finished = true;
      player.x = level.length;
      events.push({ type: 'finished' });
    }
  }

  return events;
}

export function makeInitialPlayerState() {
  return {
    x: 0,
    y: GROUND_Y - PLAYER_SIZE,
    vy: 0,
    grounded: true,
    alive: true,
    eliminated: false,
    finished: false,
    finishTime: null,
    progress: 0,
    checkpointX: 0,
  };
}

export { PLAYER_SIZE, GROUND_Y };
