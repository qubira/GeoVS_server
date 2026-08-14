// `io` se crea y se usa hoy solo dentro de index.js (nunca se exportaba).
// Las rutas HTTP (admin.js) necesitan poder llegar a el para expulsar a un
// jugador en vivo cuando se lo bloquea desde el panel. Exportar `io` directo
// desde index.js generaria un import circular (index.js importa los routers,
// que a su vez importarian io de vuelta) — este registro evita eso: index.js
// llama a setIo(io) una sola vez al arrancar, y cualquier ruta HTTP llama a
// getIo() en el momento de atender un request (para entonces el servidor ya
// esta arriba, asi que siempre esta seteado).
let ioInstance = null;

export function setIo(io) {
  ioInstance = io;
}

export function getIo() {
  return ioInstance;
}
