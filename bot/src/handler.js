import { config } from './config.js';
import { log, maskJid } from './logger.js';
import { openwa, sleep } from './openwa.js';
import { Throttle } from './throttle.js';
import { normalize, resolveReply, sweepState } from './rules.js';

const throttle = new Throttle(config.throttle);

// Reglas cuya respuesta significa "esto ya lo debe ver una persona".
const ESCALATION_RULES = new Set(['ia-escalamiento', 'media-sin-texto']);

// Limpieza periodica para que los Map no crezcan indefinidamente.
const sweeper = setInterval(() => {
  throttle.sweep();
  sweepState();
}, 60_000);
sweeper.unref();

/** ¿Estamos dentro del horario de atencion configurado? */
function withinBusinessHours(date = new Date()) {
  if (!config.businessHours.enabled) return true;

  const { timezone, days, startHour, endHour } = config.businessHours;
  // Intl nos da la hora local del negocio sin arrastrar una libreria de fechas.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdayMap[parts.find((p) => p.type === 'weekday')?.value];
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);

  if (!days.includes(weekday)) return false;
  return hour >= startHour && hour < endHour;
}

/**
 * Decide si el mensaje merece una respuesta.
 * Devuelve null si procede, o un string con el motivo del descarte.
 */
function shouldSkip(data) {
  const { ignoreGroups, ignoreBroadcast, allowlist, blocklist } = config.behaviour;

  // Nunca responder a nuestros propios mensajes: es el bucle infinito clasico.
  if (data.fromMe === true) return 'from_me';

  const chatId = data.chatId ?? data.from;
  if (!chatId) return 'sin_chat_id';

  if (ignoreBroadcast && (chatId === 'status@broadcast' || chatId.endsWith('@broadcast'))) {
    return 'broadcast';
  }

  const isGroup = data.isGroup === true || chatId.endsWith('@g.us');
  if (ignoreGroups && isGroup) return 'grupo';

  // El remitente real: en grupos es `author`, en 1:1 es `from`.
  const sender = data.author ?? data.from ?? chatId;

  if (blocklist.length && blocklist.some((entry) => sender.includes(entry))) return 'blocklist';
  if (allowlist.length && !allowlist.some((entry) => sender.includes(entry))) return 'fuera_de_allowlist';

  return null;
}

/**
 * Procesa un evento message.received. Se invoca DESPUES de haber respondido
 * 200 al webhook, asi que aqui nunca propagamos excepciones: las registramos.
 */
export async function handleMessageReceived(payload) {
  const data = payload.data ?? {};
  const chatId = data.chatId ?? data.from;

  const skip = shouldSkip(data);
  if (skip) {
    log.debug('Mensaje ignorado', { reason: skip, chatId: maskJid(chatId) });
    return;
  }

  const body = typeof data.body === 'string' ? data.body : '';
  const ctx = {
    chatId,
    body,
    text: normalize(body),
    type: data.type ?? 'chat',
    isGroup: data.isGroup === true,
    senderName: data.contact?.name ?? data.contact?.pushName ?? data.notifyName ?? null,
    messageId: data.id ?? null,
    withinBusinessHours: withinBusinessHours(),
  };

  // Comprobamos el limite ANTES de resolver la respuesta: si vamos a descartar
  // el envio, no tiene sentido pagar una llamada a la IA para generarlo.
  // peek() no consume cuota; take() la consume justo antes de enviar.
  const preGate = throttle.peek(chatId);
  if (!preGate.allowed) {
    log.warn('Respuesta omitida por limite de envio', {
      reason: preGate.reason,
      chatId: maskJid(chatId),
    });
    return;
  }

  const { rule, text } = await resolveReply(ctx);

  if (ESCALATION_RULES.has(rule)) {
    notifyEscalation(ctx, rule).catch((error) => {
      log.error('Fallo al enviar aviso de escalamiento', { error: error.message });
    });
  }

  if (!text) {
    log.info('Regla decidio no responder', { rule, chatId: maskJid(chatId) });
    return;
  }

  const gate = throttle.take(chatId);
  if (!gate.allowed) {
    // Deliberadamente NO encolamos el mensaje para mas tarde: si estamos
    // topando el limite, enviarlo despues solo mueve el riesgo de baneo.
    log.warn('Respuesta descartada por limite de envio', {
      reason: gate.reason,
      chatId: maskJid(chatId),
      rule,
    });
    return;
  }

  try {
    if (config.behaviour.markAsRead) {
      await openwa.markRead(chatId, ctx.messageId ? [ctx.messageId] : undefined).catch((error) => {
        // Marcar como leido es cosmetico: no debe impedir la respuesta.
        log.debug('No se pudo marcar como leido', { error: error.message });
      });
    }

    if (config.behaviour.simulateTyping) {
      const { typingMinMs, typingMaxMs } = config.behaviour;
      const delay = typingMinMs + Math.random() * Math.max(0, typingMaxMs - typingMinMs);
      await openwa.setChatState(chatId, 'typing').catch(() => {});
      await sleep(delay);
      await openwa.setChatState(chatId, 'paused').catch(() => {});
    }

    const result = await openwa.sendText(chatId, text, {
      quotedMessageId: config.behaviour.quoteOriginal ? ctx.messageId : undefined,
    });

    log.info('Respuesta enviada', {
      rule,
      chatId: maskJid(chatId),
      messageId: result?.messageId ?? null,
    });
  } catch (error) {
    log.error('Fallo al enviar la respuesta', {
      rule,
      chatId: maskJid(chatId),
      status: error.status ?? null,
      error: error.message,
      body: error.body ?? null,
    });
  }
}

/** Avisa por WhatsApp a NOTIFY_JID que una conversacion necesita una persona. */
async function notifyEscalation(ctx, rule) {
  if (!config.notifyJid) return;

  // Comparte el limite global con las respuestas a clientes: sigue siendo
  // un envio mas desde el mismo numero de WhatsApp.
  const gate = throttle.take(config.notifyJid);
  if (!gate.allowed) {
    log.warn('Aviso de escalamiento omitido por limite de envio', { reason: gate.reason });
    return;
  }

  const numero = ctx.chatId.split('@')[0];
  const quien = ctx.senderName ? `${ctx.senderName} (${numero})` : numero;
  const motivo = rule === 'media-sin-texto' ? 'mando un archivo o audio sin texto' : 'la IA lo derivo a una persona';
  const resumen = ctx.body ? `\n\nUltimo mensaje: "${ctx.body}"` : '';

  await openwa.sendText(config.notifyJid, `Aviso: ${quien} necesita atencion (${motivo}).${resumen}`);
  log.info('Aviso de escalamiento enviado', { chatId: maskJid(ctx.chatId), rule });
}

/** Eventos de sesion: utiles para saber si el numero se desconecto o fue restringido. */
export async function handleSessionEvent(payload) {
  const { event, data } = payload;

  if (event === 'session.restriction') {
    log.error('WhatsApp restringio la sesion — revisa la cuenta de inmediato', { data });
    return;
  }
  if (event === 'session.disconnected') {
    log.error('Sesion desconectada: hay que reescanear el QR', { data });
    return;
  }
  log.info('Evento de sesion', { event, status: data?.status ?? null });
}
