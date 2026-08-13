import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prisma } from '../db.js';

// Se carga con fs.readFileSync en lugar de un import JSON para evitar depender
// de la sintaxis de import attributes, que varia entre versiones de Node.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadLevel(fileName) {
  return JSON.parse(readFileSync(path.join(__dirname, '../levels', fileName), 'utf-8'));
}
const level1 = loadLevel('level1.json');
const level2 = loadLevel('level2.json');
const level3 = loadLevel('level3.json');

const LEVELS = {
  [level1.id]: level1,
  [level2.id]: level2,
  [level3.id]: level3,
};

// Pistas creadas desde el modulo "Crear" del panel (tabla CustomLevel). Se
// guardan aparte de LEVELS (que son los 3 niveles fijos, de solo lectura) en
// un Map en memoria, poblado al arrancar el server y mantenido al dia por
// las rutas CRUD de /admin/custom-levels via upsertCustomLevelInMemory/
// removeCustomLevelFromMemory (llamadas directas, mismo proceso — sin
// polling ni cache invalidation).
const customLevels = new Map();

function rowToLevel(row) {
  return {
    id: row.id,
    name: row.name,
    length: row.length,
    speedX: row.speedX ?? undefined,
    jumpVelocity: row.jumpVelocity ?? undefined,
    backgroundImageUrl: row.backgroundImageUrl ?? undefined,
    backgroundScale: row.backgroundScale ?? undefined,
    musicUrl: row.musicUrl ?? undefined,
    obstacles: row.obstacles,
    checkpoints: row.checkpoints,
  };
}

export async function loadCustomLevelsFromDb() {
  try {
    // Solo las publicadas: un borrador a medio armar no debe quedar
    // seleccionable por ningun jugador (ver CustomLevel.published).
    const rows = await prisma.customLevel.findMany({ where: { published: true } });
    for (const row of rows) customLevels.set(row.id, rowToLevel(row));
    console.log(`Pistas personalizadas publicadas cargadas: ${rows.length}`);
  } catch (err) {
    // Si Neon falla al arrancar, el juego sigue funcionando con los 3
    // niveles fijos (no dependen de la base de datos).
    console.error('No se pudieron cargar las pistas personalizadas al arrancar:', err);
  }
}

// IMPORTANTE: siempre reemplazar la entrada (Map.set con un objeto nuevo),
// nunca mutar el objeto existente in place — una Room en curso ya tiene una
// referencia directa a ese objeto (this.level) y mutarlo movería obstaculos
// bajo los pies de un jugador a media partida.
//
// Se llama despues de CUALQUIER escritura en Postgres (crear/editar/
// publicar/despublicar): si la fila quedo publicada, entra o se actualiza
// en el registro en memoria; si no (borrador o recien despublicada), se
// saca de ahi para que deje de aparecer en listLevels()/getLevel().
export function syncCustomLevelInMemory(row) {
  if (row.published) customLevels.set(row.id, rowToLevel(row));
  else customLevels.delete(row.id);
}

export function removeCustomLevelFromMemory(id) {
  customLevels.delete(id);
}

export function getLevel(levelId) {
  return LEVELS[levelId] || customLevels.get(levelId) || null;
}

export function listLevels() {
  return [
    ...Object.values(LEVELS).map((lvl) => ({ id: lvl.id, name: lvl.name, length: lvl.length })),
    ...[...customLevels.values()].map((lvl) => ({ id: lvl.id, name: lvl.name, length: lvl.length })),
  ];
}

export const DEFAULT_LEVEL_ID = level1.id;
