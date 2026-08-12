// Constantes de la partida. Los valores de PHYSICS deben coincidir exactamente
// con client/src/game/PhysicsEngine.js para que la prediccion local del cliente
// coincida con la simulacion autoritativa del servidor.
export const CONFIG = {
  MODE: 'race', // 'race' | 'elimination'
  RESPAWN_MODE: 'restart', // 'checkpoint' | 'restart' (solo aplica en modo race)

  TICK_RATE_HZ: 60, // frecuencia de simulacion fisica interna del servidor
  BROADCAST_RATE_HZ: 20, // frecuencia de envio de game:state a los clientes

  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,

  COUNTDOWN_SECONDS: 3,
  RESPAWN_DELAY_MS: 1000, // tiempo muerto antes de reaparecer (modo race)
  POST_WIN_GRACE_MS: 5000, // tras la primera meta, tiempo extra para que otros terminen
  ROUND_TIMEOUT_MS: 5 * 60 * 1000, // limite duro de una ronda

  PLAYER_COLORS: [
    '#ff5252', '#4fc3f7', '#69f0ae', '#ffd54f',
    '#ba68c8', '#ff8a65', '#4dd0e1', '#f06292',
  ],
};

export const PHYSICS = {
  GRAVITY: 2600, // px/s^2
  JUMP_VELOCITY: -900, // px/s (negativo = hacia arriba)
  MAX_FALL_SPEED: 1800, // px/s
  SPEED_X: 420, // px/s, velocidad de avance constante (estilo Geometry Dash)
  PLAYER_SIZE: 40, // px, cubo cuadrado
  GROUND_Y: 500, // coordenada Y del suelo
};
