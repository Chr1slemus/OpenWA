import { config } from './config.js';
import { log, maskJid } from './logger.js';

/**
 * Respuestas con IA (OpenAI Chat Completions), sin SDK: una sola llamada HTTP
 * con el fetch nativo de Node 22. Menos dependencias que auditar.
 *
 * La IA es el ULTIMO recurso: solo entra cuando ninguna regla determinista
 * coincidio. Las reglas son mas baratas, mas rapidas y predecibles; la IA
 * cubre lo que no anticipaste.
 */

const HISTORY_TURNS = 6; // 3 intercambios ida y vuelta
const HISTORY_TTL_MS = 30 * 60 * 1000;

/** chatId -> { messages: [{role, content}], updatedAt } */
const history = new Map();

function getHistory(chatId) {
  const entry = history.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > HISTORY_TTL_MS) {
    history.delete(chatId);
    return [];
  }
  return entry.messages;
}

function pushHistory(chatId, role, content) {
  const messages = getHistory(chatId);
  messages.push({ role, content });
  // Solo conservamos las ultimas vueltas: el historico completo encarece cada
  // llamada y aporta poco en una conversacion de atencion.
  history.set(chatId, {
    messages: messages.slice(-HISTORY_TURNS),
    updatedAt: Date.now(),
  });
}

export function clearHistory(chatId) {
  history.delete(chatId);
}

export function sweepHistory() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  for (const [chatId, entry] of history) {
    if (entry.updatedAt < cutoff) history.delete(chatId);
  }
}

/**
 * Marcador que el modelo emite cuando no puede resolver algo. Lo detectamos
 * para escalar a un humano en vez de dejar que invente una respuesta.
 */
const ESCALATE = '[ESCALAR]';

function buildSystemPrompt() {
  return (
    config.ai.systemPrompt ||
    `Eres el asistente de atencion al cliente de Central Global Solutions (CGS) por WhatsApp.

REGLAS ESTRICTAS:
- Responde SIEMPRE en espanol, en tono cordial y profesional, tuteando al cliente.
- Se BREVE: maximo 3 frases cortas. Es WhatsApp, no un correo.
- NUNCA inventes datos: precios, plazos de entrega, estatus de pedidos, direcciones,
  disponibilidad de inventario ni politicas. No los conoces.
- Si te piden un dato concreto que no tienes, responde exactamente con ${ESCALATE}
  y nada mas. Un asesor humano tomara la conversacion.
- No prometas nada en nombre de la empresa ni des asesoria legal, medica o financiera.
- Si el cliente pide hablar con una persona, responde ${ESCALATE}.
- Puedes sugerir que escriba *menu* para ver las opciones disponibles.
- No uses markdown salvo *negritas* de WhatsApp. Nada de listas numeradas largas.`
  );
}

/**
 * Genera una respuesta. Devuelve null si la IA no aplica, falla o decide
 * escalar: el que llama debe tener siempre un camino alternativo.
 */
export async function generateReply(ctx) {
  if (!config.ai.enabled) return null;

  const userText = (ctx.body ?? '').trim();
  if (!userText) return null;

  // Cortamos entradas desmesuradas antes de pagarlas como tokens.
  const prompt = userText.slice(0, config.ai.maxInputChars);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...getHistory(ctx.chatId),
    { role: 'user', content: prompt },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages,
        max_tokens: config.ai.maxTokens,
        temperature: config.ai.temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      log.error('La API de IA devolvio error', {
        status: response.status,
        // Recortado: el cuerpo de error puede ser largo y no aporta mas.
        detail: detail.slice(0, 300),
      });
      return null;
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();

    if (!text) {
      log.warn('La IA devolvio una respuesta vacia', { chatId: maskJid(ctx.chatId) });
      return null;
    }

    if (text.includes(ESCALATE)) {
      log.info('La IA pidio escalar a un humano', { chatId: maskJid(ctx.chatId) });
      return { escalate: true, text: null };
    }

    pushHistory(ctx.chatId, 'user', prompt);
    pushHistory(ctx.chatId, 'assistant', text);

    log.info('Respuesta generada por IA', {
      chatId: maskJid(ctx.chatId),
      model: config.ai.model,
      tokens: payload?.usage?.total_tokens ?? null,
    });

    return { escalate: false, text };
  } catch (error) {
    // Timeout, DNS, corte de red: nunca dejamos al cliente sin respuesta.
    log.error('Fallo la llamada a la IA', {
      chatId: maskJid(ctx.chatId),
      error: error.name === 'AbortError' ? `timeout tras ${config.ai.timeoutMs}ms` : error.message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
