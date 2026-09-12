/**
 * ---------------------------------------------------------------------------
 * ESTE ES EL ARCHIVO QUE VAS A EDITAR EL 90% DEL TIEMPO.
 * ---------------------------------------------------------------------------
 * Lógica conversacional. Todo lo demás (firma, reintentos, límites, red) ya
 * está resuelto y no deberías necesitar tocarlo.
 *
 * Cada regla es: { name, match(ctx), reply(ctx) }
 *  - match: true si la regla aplica al mensaje.
 *  - reply: el texto a enviar (puede ser async), o null para callar.
 * Gana la PRIMERA que coincide. Si ninguna lo hace y AI_ENABLED=true,
 * contesta la IA: las reglas van primero porque son gratis y predecibles.
 *
 * VOZ: sigue el perfil de Christian Lemus y la sección 4 del documento de
 * marca. Directa, llana, sin adorno. Sin exclamaciones, sin rayas largas, sin
 * urgencia comercial, casi sin emoji. Si editas, mantén ese registro.
 */

import { generateReply, clearHistory, sweepHistory } from './ai.js';
import { HECHOS, SERVICIOS } from './brand.js';
import { log, maskJid } from './logger.js';

const MENU = `Soy Chris, de *Central Global Solutions*.

¿Cómo puedo ayudarte?

*1* Mi empresa o proyecto no está dándome los resultados esperados y quiero saber por qué
*2* Quiero saber qué servicios ofrecen
*3* Quiero agendar una videollamada

Escribe *menú* si quieres iniciar de nuevo en cualquier momento.`;

const FUERA_DE_HORARIO = `Gracias por escribir a *Central Global Solutions*.

Estamos fuera de horario. Atendemos de lunes a viernes, de 9:00 a 18:00.

Si prefieres, agenda directo aquí: ${HECHOS.calendly}`;

const AGENDA = `La llamada es de 15 minutos, sin costo ni compromiso. Christian la toma en persona.

Agenda aquí: ${HECHOS.calendly}

Déjame tu correo y te mando la confirmación y lo que conversemos después.`;

/** chatId -> { step, email, updatedAt }. Se pierde al reiniciar el contenedor. */
const state = new Map();
const STATE_TTL_MS = 30 * 60 * 1000;

export function getState(chatId) {
  const entry = state.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STATE_TTL_MS) {
    state.delete(chatId);
    return null;
  }
  return entry;
}

export function setState(chatId, step, extra = {}) {
  const previo = state.get(chatId) ?? {};
  state.set(chatId, { ...previo, ...extra, step, updatedAt: Date.now() });
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

/** Normaliza: minusculas, sin acentos, sin espacios sobrantes. */
export function normalize(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

const saludos = [
  'hola', 'holi', 'hello', 'hey', 'buenas', 'buenos dias', 'buenas tardes',
  'buenas noches', 'que tal', 'que ondas', 'kiubo', 'saludos',
];
// \b en vez de exigir un espacio exacto despues: asi "hola," "hola!" y
// "hola quiero saber mas" cuentan igual como saludo inicial.
const SALUDO_RE = new RegExp(`^(${saludos.join('|')})\\b`);

// Corte por conducta impropia. Lista corta y explícita: preferimos dejar pasar
// un caso dudoso a la IA antes que cortarle la conversación a un cliente real
// por un falso positivo.
const OFENSIVO = /\b(put[oa]s?|mierda|imbecil|idiota|estupid[oa]|pendej[oa]|maric[oa]n|verga|culer[oa]|jodete|vete a la)\b/i;

export const rules = [
  {
    name: 'conducta-impropia',
    match: (ctx) => OFENSIVO.test(ctx.text),
    reply: (ctx) => {
      log.warn('Conversacion cerrada por conducta impropia', { chatId: maskJid(ctx.chatId) });
      setState(ctx.chatId, 'cerrado');
      clearHistory(ctx.chatId);
      return 'Aquí lo dejamos. Si más adelante quieres conversar de negocios, con gusto.';
    },
  },

  {
    name: 'conversacion-cerrada',
    // Una vez cerrada, no se reabre sola. Solo un "menu" explícito la reinicia.
    match: (ctx) => getState(ctx.chatId)?.step === 'cerrado' && ctx.text !== 'menu',
    reply: () => null,
  },

  {
    name: 'fuera-de-horario',
    match: (ctx) => !ctx.withinBusinessHours && !getState(ctx.chatId),
    reply: () => FUERA_DE_HORARIO,
  },

  {
    name: 'captura-correo',
    // El correo es el activo de la conversación: permite mandar propuesta y
    // documentación. Se detecta en cualquier momento, no solo cuando se pide.
    match: (ctx) => EMAIL_RE.test(ctx.body) && !getState(ctx.chatId)?.email,
    reply: (ctx) => {
      const email = ctx.body.match(EMAIL_RE)[0];
      setState(ctx.chatId, getState(ctx.chatId)?.step ?? 'menu', { email });
      log.info('Correo capturado', { chatId: maskJid(ctx.chatId) });
      return `Anotado. Te escribo ahí.

Si quieres adelantar camino, agenda los 15 minutos con Christian: ${HECHOS.calendly}`;
    },
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
    match: (ctx) => SALUDO_RE.test(ctx.text),
    reply: (ctx) => {
      setState(ctx.chatId, 'menu');
      const nombre = ctx.senderName ? `Hola, ${ctx.senderName.split(' ')[0]}.` : 'Hola.';
      return `${nombre} ${MENU}`;
    },
  },

  {
    name: 'opcion-menu',
    match: (ctx) => getState(ctx.chatId)?.step === 'menu' && ['1', '2', '3'].includes(ctx.text),
    reply: (ctx) => {
      switch (ctx.text) {
        case '1':
          setState(ctx.chatId, 'sintoma');
          return `Ese es el problema que trabajamos. Casi todas las empresas sienten el síntoma, muy pocas ubican la causa.

Cuéntame qué estás viendo. Ventas planas, rotación, márgenes que se encogen, proyectos que no cierran.`;
        case '2':
          // Se queda en 'menu', no en un paso nuevo: la respuesta invita a
          // escribir *3* a continuacion, y eso solo funciona si el estado
          // sigue siendo 'menu' cuando llega ese digito.
          setState(ctx.chatId, 'menu');
          return `${HECHOS.mantra} En ese orden.

Trabajamos con empresas establecidas que llevan años sin crecer, sobre todo en ${HECHOS.sectores.slice(0, 3).join(', ').toLowerCase()} y manufactura. ${HECHOS.trayectoriaFirma}

Hacemos ${SERVICIOS.slice(0, 4).join(', ').toLowerCase()} y consultoría en IA. Escribe *3* y lo vemos en 15 minutos.`;
        case '3':
          setState(ctx.chatId, 'agenda');
          return AGENDA;
        default:
          return null;
      }
    },
  },

  {
    name: 'sintoma-descrito',
    match: (ctx) => getState(ctx.chatId)?.step === 'sintoma' && ctx.body.length > 25,
    reply: (ctx) => {
      // Deliberadamente NO damos el diagnóstico. Apuntamos la dirección y
      // llevamos a la llamada: nombrar la causa sin ver la operación es adivinar.
      setState(ctx.chatId, 'agenda');
      return `Lo que describes suele tener más de una causa posible, y casi nunca es la que parece a simple vista. Acertar sin ver la operación por dentro sería adivinar, y adivinar sale caro.

Eso es exactamente lo que resolvemos en 15 minutos: ${HECHOS.calendly}

Déjame tu correo y te mando lo que conversemos.`;
    },
  },

  {
    name: 'agendar',
    match: (ctx) => /\b(agendar|agenda|cita|reunion|llamada|calendly|meeting)\b/.test(ctx.text),
    reply: (ctx) => {
      setState(ctx.chatId, 'agenda');
      return AGENDA;
    },
  },

  {
    name: 'precio',
    match: (ctx) => /\b(precio|costo|cuanto cuesta|cuanto vale|tarifa|honorarios|cotizacion|presupuesto)\b/.test(ctx.text),
    reply: (ctx) => {
      setState(ctx.chatId, 'agenda');
      return `Depende del alcance, y el alcance no se define sin entender primero el problema. Darte una cifra ahora sería inventarla.

Para eso son los 15 minutos, y no cuestan nada: ${HECHOS.calendly}`;
    },
  },

  {
    name: 'agradecimiento',
    match: (ctx) => ['gracias', 'muchas gracias', 'ok gracias', 'perfecto gracias', 'listo gracias'].includes(ctx.text),
    reply: (ctx) => {
      clearHistory(ctx.chatId);
      return 'Con gusto. Si necesitas algo más, escribe *menú*.';
    },
  },

  {
    name: 'media-sin-texto',
    match: (ctx) => ctx.type !== 'chat' && !ctx.body,
    reply: (ctx) => {
      setState(ctx.chatId, 'asesor');
      return 'Recibido. Christian lo revisa y te responde.';
    },
  },
];

const ESCALADO = `Le paso esto a Christian. ${HECHOS.tiempoRespuesta}

Si prefieres no esperar, agenda los 15 minutos: ${HECHOS.calendly}`;

/** Respuesta cuando ninguna regla coincidió. */
export async function fallback(ctx) {
  const current = getState(ctx.chatId);

  // Ya pidió hablar con una persona: el bot se calla. Nada peor que un bot
  // insistiendo cuando el cliente ya pidió un humano.
  if (current?.step === 'asesor') return { rule: 'silencio-asesor', text: null };

  const ai = await generateReply(ctx);

  if (ai?.escalate) {
    setState(ctx.chatId, 'asesor');
    clearHistory(ctx.chatId);
    return { rule: 'ia-escalamiento', text: ESCALADO };
  }

  if (ai?.text) return { rule: 'ia', text: ai.text };

  // La IA está apagada o falló. La PRIMERA vez que no entendemos, pedimos que
  // lo reescriban en vez de soltar el menú de golpe: se siente menos a
  // maquina. Si vuelve a fallar seguido, ahí sí mostramos el menú: el
  // cliente nunca se queda sin salida por quedarse atascado en la duda.
  const intentosFallidos = (current?.misses ?? 0) + 1;
  if (intentosFallidos >= 2) {
    setState(ctx.chatId, 'menu', { misses: 0 });
    return { rule: 'fallback-menu', text: `No logro entender bien. Vamos de nuevo.\n\n${MENU}` };
  }
  setState(ctx.chatId, current?.step ?? 'menu', { misses: intentosFallidos });
  return { rule: 'fallback-pensar', text: 'Déjame pensar. ¿Me lo puedes escribir de otra forma, en una frase corta?' };
}

/** Resuelve el texto de respuesta. null = no responder. */
export async function resolveReply(ctx) {
  for (const rule of rules) {
    if (rule.match(ctx)) {
      const text = await rule.reply(ctx);
      // Cualquier regla reconocida borra el contador de "no entendi": el
      // cliente ya se hizo entender, no cargamos esa duda a la siguiente vez.
      const entry = getState(ctx.chatId);
      if (entry?.misses) setState(ctx.chatId, entry.step, { misses: 0 });
      return { rule: rule.name, text };
    }
  }
  return fallback(ctx);
}
