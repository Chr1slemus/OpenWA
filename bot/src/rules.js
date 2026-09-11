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
 *
 * VOZ: el texto de abajo sigue la seccion 4 del documento de marca. Calma,
 * directa, sustantiva. Sin signos de exclamacion, sin rayas largas, sin
 * urgencia comercial y casi sin emoji. Si editas, manten ese registro.
 */

import { generateReply, clearHistory, sweepHistory } from './ai.js';
import { HECHOS } from './brand.js';

const MENU = `Soy el asistente de *Central Global Solutions*.

Escribe el numero de lo que necesitas:

*1* Mi empresa dejo de crecer y no se por que
*2* Que hacemos y para quien
*3* Agendar la llamada de diagnostico
*4* Hablar con alguien del equipo

Puedes escribir *menu* en cualquier momento para volver aqui.`;

const FUERA_DE_HORARIO = `Gracias por escribir a *Central Global Solutions*.

Estamos fuera de horario. Atendemos de lunes a viernes, de 9:00 a 18:00.

Dejanos tu mensaje y alguien del equipo te responde al abrir.`;

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

const saludos = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'saludos'];

/**
 * ctx = {
 *   chatId, body, text (normalizado), type, isGroup, senderName,
 *   messageId, withinBusinessHours
 * }
 */
export const rules = [
  {
    name: 'fuera-de-horario',
    // Solo interrumpe en el primer contacto. Si ya esta dentro del menu,
    // dejamos que termine lo que empezo.
    match: (ctx) => !ctx.withinBusinessHours && !getState(ctx.chatId),
    reply: () => FUERA_DE_HORARIO,
  },

  {
    name: 'menu-explicito',
    match: (ctx) => ['menu', 'inicio', 'opciones', '0'].includes(ctx.text),
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
      const nombre = ctx.senderName ? `Hola, ${ctx.senderName.split(' ')[0]}.` : 'Hola.';
      return `${nombre} ${MENU}`;
    },
  },

  {
    name: 'opcion-menu',
    match: (ctx) => getState(ctx.chatId)?.step === 'menu' && ['1', '2', '3', '4'].includes(ctx.text),
    reply: (ctx) => {
      switch (ctx.text) {
        case '1':
          setState(ctx.chatId, 'sintoma');
          // No diagnosticamos aqui. Solo ayudamos a precisar el sintoma, que
          // es lo que hace util la llamada posterior.
          return `Ese es exactamente el problema que trabajamos: la mayoria de empresas siente el sintoma pero no ubica la causa.

Cuentanos en un mensaje que estas viendo. Por ejemplo: ventas planas, rotacion de personal, margenes que se encogen, proyectos que no cierran.`;
        case '2':
          setState(ctx.chatId, 'servicios');
          return `${HECHOS.mantra} En ese orden.

Trabajamos con empresas establecidas que llevan anos sin crecer, sobre todo en finanzas, salud, seguros y manufactura. ${HECHOS.trayectoria}

Tenemos tres formas de trabajar: un diagnostico inicial, una consultoria estrategica completa y un acompanamiento continuo. Escribe *3* si quieres que conversemos cual encaja.`;
        case '3':
          setState(ctx.chatId, 'asesor');
          return `Con gusto. El primer paso es una llamada de 15 a 20 minutos, sin costo ni compromiso.

Dejanos tu nombre, tu empresa y dos horarios que te acomoden. ${HECHOS.tiempoRespuesta}`;
        case '4':
          setState(ctx.chatId, 'asesor');
          return `Listo. Ya avisamos a alguien del equipo.

${HECHOS.tiempoRespuesta} Dejanos aqui el contexto que quieras adelantar.`;
        default:
          return null;
      }
    },
  },

  {
    name: 'sintoma-descrito',
    match: (ctx) => getState(ctx.chatId)?.step === 'sintoma' && ctx.body.length > 25,
    reply: (ctx) => {
      // Deliberadamente NO devolvemos una hipotesis. Nombrar la causa es el
      // trabajo que se cobra, y hacerlo sin observacion directa seria adivinar.
      setState(ctx.chatId, 'asesor');
      clearHistory(ctx.chatId);
      return `Gracias. Lo que describes puede tener varias causas, y acertar sin ver la operacion por dentro seria adivinar.

Esa es justo la conversacion de la llamada de diagnostico: 15 a 20 minutos, sin costo. Dejanos tu nombre, tu empresa y dos horarios que te acomoden.`;
    },
  },

  {
    name: 'precio',
    match: (ctx) => /\b(precio|costo|cuanto cuesta|cuanto vale|tarifa|honorarios|cotizacion)\b/.test(ctx.text),
    reply: (ctx) => {
      setState(ctx.chatId, 'asesor');
      return `Depende del alcance, y el alcance no se puede definir sin entender primero el problema. Darte una cifra ahora seria inventarla.

La llamada de diagnostico es justamente para eso, y no tiene costo. Dejanos tu nombre, tu empresa y dos horarios que te acomoden.`;
    },
  },

  {
    name: 'agradecimiento',
    match: (ctx) => ['gracias', 'muchas gracias', 'ok gracias', 'perfecto gracias', 'listo gracias'].includes(ctx.text),
    reply: (ctx) => {
      clearState(ctx.chatId);
      clearHistory(ctx.chatId);
      return 'Con gusto. Si necesitas algo mas, escribe *menu*.';
    },
  },

  {
    name: 'media-sin-texto',
    match: (ctx) => ctx.type !== 'chat' && !ctx.body,
    reply: (ctx) => {
      setState(ctx.chatId, 'asesor');
      return `Recibimos tu archivo. Alguien del equipo lo revisa y te responde.`;
    },
  },
];

const ESCALADO = `Vamos a pasarte con alguien del equipo. ${HECHOS.tiempoRespuesta}`;

/** Respuesta cuando ninguna regla coincidio. */
export async function fallback(ctx) {
  const current = getState(ctx.chatId);

  // Si ya pidio hablar con una persona, el bot se calla. Nada peor que un bot
  // insistiendo cuando el cliente ya pidio un humano.
  if (current?.step === 'asesor') return { rule: 'silencio-asesor', text: null };

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
  return { rule: 'fallback-menu', text: `No estoy seguro de haber entendido.\n\n${MENU}` };
}

/** Resuelve el texto de respuesta para un mensaje. null = no responder. */
export async function resolveReply(ctx) {
  for (const rule of rules) {
    if (rule.match(ctx)) {
      // `reply` puede ser async: asi una regla puede consultar tu CRM.
      const text = await rule.reply(ctx);
      return { rule: rule.name, text };
    }
  }
  return fallback(ctx);
}
