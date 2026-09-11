/**
 * ---------------------------------------------------------------------------
 * ESTE ES EL ARCHIVO QUE VAS A EDITAR EL 90% DEL TIEMPO.
 * ---------------------------------------------------------------------------
 * Aqui vive la logica conversacional. Todo lo demas (firma, reintentos,
 * limites, red) ya esta resuelto y no deberias necesitar tocarlo.
 *
 * Cada regla es: { name, match(ctx), reply(ctx) }
 *  - match: devuelve true si la regla aplica al mensaje.
 *  - reply: devuelve el texto a enviar (puede ser async), o null para callar.
 * Se evalua en orden y gana la PRIMERA que coincide.
 *
 * Si ninguna coincide y AI_ENABLED=true, contesta la IA. Las reglas van
 * primero a proposito: son gratis, instantaneas y predecibles.
 */

import { generateReply, clearHistory, sweepHistory } from './ai.js';

const MENU = `Hola 👋 Soy el asistente de *Central Global Solutions*.

Escribe el numero de lo que necesitas:

*1* — Cotizacion
*2* — Estado de mi pedido
*3* — Soporte tecnico
*4* — Hablar con un asesor

Puedes escribir *menu* en cualquier momento para volver aqui.`;

const FUERA_DE_HORARIO = `Gracias por escribir a *Central Global Solutions*.

En este momento estamos fuera de horario de atencion.
Nuestro horario es de *lunes a viernes, 9:00 a 18:00*.

Deja tu mensaje y te respondemos en cuanto abramos. 🙌`;

/**
 * Memoria de conversacion en RAM: chatId -> { step, updatedAt }.
 * Se pierde al reiniciar el contenedor, que para un menu corto es aceptable.
 * Si necesitas que sobreviva reinicios, cambia este Map por Redis o Postgres.
 */
const state = new Map();
const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutos de inactividad

export function getState(chatId) {
  const entry = state.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STATE_TTL_MS) {
    state.delete(chatId);
    return null;
  }
  return entry;
}

export function setState(chatId, step) {
  state.set(chatId, { step, updatedAt: Date.now() });
}

export function clearState(chatId) {
  state.delete(chatId);
}

export function sweepState() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [chatId, entry] of state) {
    if (entry.updatedAt < cutoff) state.delete(chatId);
  }
  sweepHistory();
}

/** Normaliza el texto: minusculas, sin acentos, sin espacios sobrantes. */
export function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const saludos = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'que tal'];

/**
 * ctx = {
 *   chatId, body, text (normalizado), type, isGroup, senderName,
 *   messageId, withinBusinessHours
 * }
 */
export const rules = [
  {
    name: 'fuera-de-horario',
    // Solo interrumpe el flujo en el primer contacto; si el cliente ya esta
    // dentro del menu, dejamos que termine lo que empezo.
    match: (ctx) => !ctx.withinBusinessHours && !getState(ctx.chatId),
    reply: () => FUERA_DE_HORARIO,
  },

  {
    name: 'menu-explicito',
    match: (ctx) => ['menu', 'menú', 'inicio', '0'].includes(ctx.text),
    reply: (ctx) => {
      setState(ctx.chatId, 'menu');
      return MENU;
    },
  },

  {
    name: 'saludo',
    match: (ctx) => saludos.some((s) => ctx.text === s || ctx.text.startsWith(`${s} `)),
    reply: (ctx) => {
      setState(ctx.chatId, 'menu');
      const nombre = ctx.senderName ? `, ${ctx.senderName.split(' ')[0]}` : '';
      return MENU.replace('Hola 👋', `Hola${nombre} 👋`);
    },
  },

  {
    name: 'opcion-menu',
    match: (ctx) => getState(ctx.chatId)?.step === 'menu' && ['1', '2', '3', '4'].includes(ctx.text),
    reply: (ctx) => {
      switch (ctx.text) {
        case '1':
          setState(ctx.chatId, 'cotizacion');
          return 'Con gusto preparamos tu cotizacion 📄\n\nCuentame en un mensaje:\n• Que producto o servicio necesitas\n• Cantidad aproximada\n• Ciudad de entrega';
        case '2':
          setState(ctx.chatId, 'pedido');
          return 'Perfecto. Enviame tu *numero de pedido* (por ejemplo CGS-10245) y lo reviso en seguida. 🔎';
        case '3':
          setState(ctx.chatId, 'soporte');
          return 'Lamento el inconveniente 🛠️\n\nDescribeme el problema con el mayor detalle posible. Si puedes, adjunta una foto o captura de pantalla.';
        case '4':
          setState(ctx.chatId, 'asesor');
          return 'Listo, ya avise a un asesor humano 🙋\n\nEn breve te escribe por este mismo chat. El bot deja de responder aqui para no interrumpir.';
        default:
          return null;
      }
    },
  },

  {
    name: 'numero-de-pedido',
    match: (ctx) => getState(ctx.chatId)?.step === 'pedido' && /cgs[- ]?\d{4,}/i.test(ctx.text),
    reply: (ctx) => {
      const pedido = ctx.body.match(/CGS[- ]?\d{4,}/i)?.[0]?.toUpperCase();
      clearState(ctx.chatId);
      // Aqui es donde conectarias tu ERP / base de datos real.
      return `Recibido. Estoy consultando el pedido *${pedido}*.\n\nUn asesor te confirma el estatus en unos minutos. 📦`;
    },
  },

  {
    name: 'agradecimiento',
    match: (ctx) => ['gracias', 'muchas gracias', 'ok gracias', 'perfecto gracias'].includes(ctx.text),
    reply: (ctx) => {
      clearState(ctx.chatId);
      return 'Con gusto 🙌 Si necesitas algo mas, escribe *menu*.';
    },
  },

  {
    name: 'media-sin-texto',
    match: (ctx) => ctx.type !== 'chat' && !ctx.body,
    reply: () => 'Recibi tu archivo 📎 Dame un momento, un asesor lo revisa y te responde.',
  },
];

const ESCALADO =
  'Dejame conectarte con un asesor 🙋 En breve te escribe por este mismo chat.';

/** Respuesta cuando ninguna regla coincidio. */
export async function fallback(ctx) {
  const current = getState(ctx.chatId);

  // Si el cliente pidio un asesor humano, el bot se calla. Nada peor que un
  // bot insistiendo cuando ya pidio hablar con una persona.
  if (current?.step === 'asesor') return { rule: 'silencio-asesor', text: null };

  // Si esta en medio de un flujo, tomamos su mensaje como la informacion
  // pedida y lo escalamos, en vez de repetirle el menu.
  if (current && current.step !== 'menu') {
    clearState(ctx.chatId);
    clearHistory(ctx.chatId);
    return {
      rule: 'flujo-completado',
      text: 'Gracias por la informacion ✅ Ya la pase con el area correspondiente, te contactan en breve.',
    };
  }

  // Ultimo recurso: la IA. Solo llega aqui lo que las reglas no anticiparon.
  const ai = await generateReply(ctx);

  if (ai?.escalate) {
    setState(ctx.chatId, 'asesor');
    clearHistory(ctx.chatId);
    return { rule: 'ia-escalamiento', text: ESCALADO };
  }

  if (ai?.text) {
    return { rule: 'ia', text: ai.text };
  }

  // La IA esta apagada o fallo: el menu deterministico sigue ahi. El cliente
  // nunca se queda sin respuesta por un problema del proveedor de IA.
  setState(ctx.chatId, 'menu');
  return { rule: 'fallback-menu', text: `No estoy seguro de haber entendido 🤔\n\n${MENU}` };
}

/** Resuelve el texto de respuesta para un mensaje. null = no responder. */
export async function resolveReply(ctx) {
  for (const rule of rules) {
    if (rule.match(ctx)) {
      // `reply` puede ser async: asi una regla puede consultar tu ERP.
      const text = await rule.reply(ctx);
      return { rule: rule.name, text };
    }
  }
  return fallback(ctx);
}
