/**
 * OpenWA reintenta las entregas fallidas y reutiliza la misma
 * X-OpenWA-Idempotency-Key. Sin esto, un timeout de nuestro lado se traduce
 * en el cliente recibiendo la misma respuesta dos o tres veces.
 *
 * Set con expulsion FIFO: suficiente para un proceso unico. Si algun dia
 * corres varias replicas del bot, mueve esto a Redis (SET key NX EX 3600).
 */
export class Dedupe {
  #seen = new Set();
  #maxSize;

  constructor(maxSize = 5000) {
    this.#maxSize = maxSize;
  }

  /** Devuelve true si la clave ya se habia procesado antes. */
  check(key) {
    if (!key) return false;
    if (this.#seen.has(key)) return true;

    this.#seen.add(key);
    if (this.#seen.size > this.#maxSize) {
      // Set preserva el orden de insercion: el primero es el mas antiguo.
      const oldest = this.#seen.values().next().value;
      this.#seen.delete(oldest);
    }
    return false;
  }
}
