import { config } from './config.js';
import { log } from './logger.js';

const { baseUrl, apiKey, sessionId, timeoutMs, retries } = config.openwa;

class OpenWAError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'OpenWAError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Llama a la API de OpenWA con timeout y reintentos.
 *
 * Solo reintenta fallos transitorios (red, 429, 5xx). Un 4xx distinto de 429
 * significa que la peticion esta mal formada: reintentarla solo gastaria cuota
 * del rate limiter y retrasaria el error real.
 */
async function request(method, path, body) {
  const url = `${baseUrl}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = text ? safeJson(text) : null;

      if (response.ok) return parsed;

      const retriable = response.status === 429 || response.status >= 500;
      lastError = new OpenWAError(`${method} ${path} devolvio ${response.status}`, {
        status: response.status,
        body: parsed ?? text,
      });
      if (!retriable) throw lastError;
    } catch (error) {
      if (error instanceof OpenWAError && error.status && error.status < 500 && error.status !== 429) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      const backoff = 500 * 2 ** attempt;
      log.warn('Reintentando llamada a OpenWA', {
        path,
        attempt: attempt + 1,
        backoffMs: backoff,
        error: lastError?.message,
      });
      await sleep(backoff);
    }
  }

  throw lastError ?? new OpenWAError(`${method} ${path} fallo sin detalle`);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sessionPath = `/sessions/${encodeURIComponent(sessionId)}`;

export const openwa = {
  /** Estado de la sesion de WhatsApp. */
  getSession() {
    return request('GET', sessionPath);
  },

  /** Envia texto. `quotedMessageId` lo convierte en una respuesta citada. */
  sendText(chatId, text, { quotedMessageId, linkPreview = false, mentions } = {}) {
    return request('POST', `${sessionPath}/messages/send-text`, {
      chatId,
      text,
      linkPreview,
      ...(quotedMessageId ? { quotedMessageId } : {}),
      ...(mentions ? { mentions } : {}),
    });
  },

  /** Envia una imagen por URL publica o base64. */
  sendImage(chatId, { url, base64, mimetype, filename, caption }) {
    return request('POST', `${sessionPath}/messages/send-image`, {
      chatId,
      ...(url ? { url } : {}),
      ...(base64 ? { base64, mimetype } : {}),
      ...(filename ? { filename } : {}),
      ...(caption ? { caption } : {}),
    });
  },

  /** Marca el chat (o mensajes concretos) como leido. */
  markRead(chatId, messageIds) {
    return request('POST', `${sessionPath}/chats/read`, {
      chatId,
      ...(messageIds?.length ? { messageIds: messageIds.slice(0, 100) } : {}),
    });
  },

  /** Estado de escritura: 'typing' | 'recording' | 'paused'. */
  setChatState(chatId, state) {
    return request('POST', `${sessionPath}/chats/typing`, { chatId, state });
  },
};

export { OpenWAError };
