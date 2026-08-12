// Bucle de simulacion de una Room. Corre la fisica a TICK_RATE_HZ (ej. 60) para
// que la simulacion sea precisa, pero solo transmite el estado a los clientes a
// BROADCAST_RATE_HZ (ej. 20) para ahorrar ancho de banda: no hace falta que la
// red reciba cada tick fisico, solo lo suficiente para que la interpolacion en
// el cliente se vea fluida.
export class GameLoop {
  constructor({ tickRateHz, broadcastRateHz, onTick, onBroadcast }) {
    this.tickIntervalMs = 1000 / tickRateHz;
    this.ticksPerBroadcast = Math.max(1, Math.round(tickRateHz / broadcastRateHz));
    this.onTick = onTick;
    this.onBroadcast = onBroadcast;
    this.tickCount = 0;
    this.timer = null;
    this.lastTime = null;
  }

  start() {
    this.lastTime = Date.now();
    this.timer = setInterval(() => this._loop(), this.tickIntervalMs);
  }

  _loop() {
    const now = Date.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    this.onTick(dt);
    this.tickCount += 1;
    if (this.tickCount % this.ticksPerBroadcast === 0) {
      this.onBroadcast();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
