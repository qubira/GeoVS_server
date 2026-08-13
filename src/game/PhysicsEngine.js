import { PHYSICS } from '../config.js';

const { GRAVITY, JUMP_VELOCITY, MAX_FALL_SPEED, SPEED_X, PLAYER_SIZE, GROUND_Y } = PHYSICS;

// Margen de "perdon": la caja de colision contra obstaculos es mas chica que
// el cubo visible (40x40). Sin esto, un salto que se ve limpio en pantalla
// puede "morir" por un roce de pocos pixeles contra la esquina invisible del
// sprite (los picos se dibujan como triangulo pero su caja era el cuadrado
// completo). No afecta el suelo ni el tamano visual, solo esta comprobacion.
const HITBOX_MARGIN = 6;

// Doble salto: el jugador puede saltar una vez mas en el aire (sin volver a
// tocar el suelo) para alcanzar plataformas altas. Se resetea a 0 cada vez
// que aterriza (suelo o encima de un bloque/plataforma).
const MAX_JUMPS = 2;

// Resuelve la colision de un jugador contra UN obstaculo (AABB con margen de
// perdon). `prevY` es la posicion Y del jugador ANTES de moverse este tick.
//
// El chequeo vertical es un barrido (swept), no solo la posicion final: a
// velocidades altas (caida rapida, MAX_FALL_SPEED=1800px/s -> 30px por tick
// a 60Hz) el jugador puede recorrer en UN tick mas distancia que el alto de
// un objeto fino (una plataforma de 20px, por ejemplo), asi que comparar
// solo la posicion final podia no detectar overlap nunca — el jugador
// "traspasaba" el objeto de un salto entre dos ticks. Usar el rango
// [min(prevY,newY) .. max(prevY,newY)] para el chequeo vertical evita eso
// sin importar que tan rapido se mueva.
function resolveObstacle(player, obstacle, prevY) {
  const left = player.x + HITBOX_MARGIN;
  const right = player.x + PLAYER_SIZE - HITBOX_MARGIN;
  const obsLeft = obstacle.x;
  const obsRight = obstacle.x + obstacle.w;
  const obsTop = obstacle.y;
  const obsBottom = obstacle.y + obstacle.h;

  const horizontalOverlap = right > obsLeft && left < obsRight;
  if (!horizontalOverlap) return null;

  const prevTop = prevY + HITBOX_MARGIN;
  const prevBottom = prevY + PLAYER_SIZE - HITBOX_MARGIN;
  const newTop = player.y + HITBOX_MARGIN;
  const newBottom = player.y + PLAYER_SIZE - HITBOX_MARGIN;
  const sweepTop = Math.min(prevTop, newTop);
  const sweepBottom = Math.max(prevBottom, newBottom);
  const verticalHit = sweepBottom > obsTop && sweepTop < obsBottom;
  if (!verticalHit) return null;

  if (obstacle.type === 'spike') {
    return { type: 'death' };
  }

  // block / platform: solo es seguro si el jugador caia y su punto mas bajo,
  // ANTES de moverse este tick, ya estaba a la altura de la superficie o por
  // encima (evita "aterrizar" si veniamos de atravesar desde abajo).
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

  const prevY = player.y;

  // Avance horizontal constante (estilo Geometry Dash: la camara/nivel corre
  // solo). Las pistas creadas desde el panel pueden traer su propia
  // velocidad/salto (level.speedX/level.jumpVelocity); si no, se usan los
  // valores globales de siempre. ESPEJO EXACTO de PhysicsEngine.ts del
  // cliente web — cualquier cambio aca debe replicarse ahi.
  player.x += (level.speedX ?? SPEED_X) * dt;

  // Gravedad y salto (con doble salto: solo se dispara en el flanco de
  // subida del input, para no reusar la misma pulsacion mantenida)
  player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL_SPEED);
  const jumpPressed = input.jumpHeld && !player.prevJumpHeld;
  player.prevJumpHeld = input.jumpHeld;
  if (jumpPressed && player.jumpsUsed < MAX_JUMPS) {
    player.vy = level.jumpVelocity ?? JUMP_VELOCITY;
    player.grounded = false;
    player.jumpsUsed += 1;
  }
  player.y += player.vy * dt;

  // Colision con el suelo
  player.grounded = false;
  if (player.y + PLAYER_SIZE >= GROUND_Y) {
    player.y = GROUND_Y - PLAYER_SIZE;
    player.vy = 0;
    player.grounded = true;
    player.jumpsUsed = 0;
  }

  // Colision con obstaculos del nivel (solo los cercanos en X, por rendimiento)
  for (const obstacle of level.obstacles) {
    if (obstacle.x + obstacle.w < player.x - 50 || obstacle.x > player.x + PLAYER_SIZE + 50) {
      continue;
    }
    const result = resolveObstacle(player, obstacle, prevY);
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
      player.jumpsUsed = 0;
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
    jumpsUsed: 0,
    prevJumpHeld: false,
    alive: true,
    eliminated: false,
    finished: false,
    finishTime: null,
    progress: 0,
    checkpointX: 0,
  };
}

export { PLAYER_SIZE, GROUND_Y };
