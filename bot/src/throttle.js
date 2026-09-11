/**
 * Limitador de envios. No es una optimizacion: es la proteccion principal
 * contra que WhatsApp restrinja el numero.
 *
 * Dos niveles:
 *  - por chat: evita bucles infinitos si el otro extremo tambien es un bot.
 *  - global:   techo duro de mensajes por ventana en toda la instancia.
 */
export class Throttle {
  #perChat = new Map(); // chatId -> number[] (timestamps)
  #global = []; // timestamps
  #config;

  constructor({ maxRepliesPerChat, windowMs, maxRepliesGlobal }) {
    this.#config = { maxRepliesPerChat, windowMs, maxRepliesGlobal };
  }

  /**
   * Consulta el limite SIN consumir cuota. Sirve para abortar temprano un
   * trabajo caro (una llamada a la IA) que de todos modos no se enviaria.
   */
  peek(chatId) {
    const cutoff = Date.now() - this.#config.windowMs;
    if (this.#global.filter((ts) => ts > cutoff).length >= this.#config.maxRepliesGlobal) {
      return { allowed: false, reason: 'global_rate_limit' };
    }
    const chatHits = (this.#perChat.get(chatId) ?? []).filter((ts) => ts > cutoff);
    if (chatHits.length >= this.#config.maxRepliesPerChat) {
      return { allowed: false, reason: 'chat_rate_limit' };
    }
    return { allowed: true };
  }

  /**
   * Registra un intento de envio. Devuelve { allowed, reason }.
   * Solo consume cuota cuando efectivamente permite el envio.
   */
  take(chatId) {
    const now = Date.now();
    const cutoff = now - this.#config.windowMs;

    this.#global = this.#global.filter((ts) => ts > cutoff);
    if (this.#global.length >= this.#config.maxRepliesGlobal) {
      return { allowed: false, reason: 'global_rate_limit' };
    }

    const chatHits = (this.#perChat.get(chatId) ?? []).filter((ts) => ts > cutoff);
    if (chatHits.length >= this.#config.maxRepliesPerChat) {
      this.#perChat.set(chatId, chatHits);
      return { allowed: false, reason: 'chat_rate_limit' };
    }

    chatHits.push(now);
    this.#perChat.set(chatId, chatHits);
    this.#global.push(now);
    return { allowed: true };
  }

  /** Elimina los chats sin actividad reciente para que el Map no crezca sin fin. */
  sweep() {
    const cutoff = Date.now() - this.#config.windowMs;
    for (const [chatId, hits] of this.#perChat) {
      const fresh = hits.filter((ts) => ts > cutoff);
      if (fresh.length === 0) this.#perChat.delete(chatId);
      else this.#perChat.set(chatId, fresh);
    }
  }
}
