import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

export function getLevel(levelId) {
  return LEVELS[levelId] || null;
}

export function listLevels() {
  return Object.values(LEVELS).map((lvl) => ({ id: lvl.id, name: lvl.name, length: lvl.length }));
}

export const DEFAULT_LEVEL_ID = level1.id;
