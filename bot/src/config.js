/**
 * Configuracion del bot. Todo se lee de variables de entorno.
 * Falla al arrancar (fail fast) si falta algo obligatorio, en vez de
 * descubrirlo cuando llega el primer mensaje.
 */

// Pistas para que un arranque fallido diga QUE hacer, no solo que fallo.
// Es esperable en el primer despliegue: la API key no existe hasta que OpenWA
// arranca, asi que el bot reinicia en bucle hasta que la rellenas.
const HINTS = {
  OPENWA_API_KEY:
    'Creala en el dashboard (API Keys, rol OPERATOR, limitada a la sesion) y ponla en las variables del stack. ' +
    'En el PRIMER despliegue aun no existe: es normal que el bot reinicie hasta entonces.',
  WEBHOOK_SECRET: 'Generalo con: openssl rand -hex 32 (minimo 16 caracteres).',
  OPENWA_SESSION_ID: 'El nombre de la sesion de WhatsApp, p.ej. cgs-main.',
};

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    const hint = HINTS[name] ? `\n  → ${HINTS[name]}` : '';
    throw new Error(`Falta la variable de entorno obligatoria: ${name}${hint}`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} debe ser un entero, se recibio: ${raw}`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'si'].includes(raw.trim().toLowerCase());
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  // --- Servidor del bot ---
  port: int('PORT', 3000),
  webhookPath: optional('WEBHOOK_PATH', '/webhook'),
  logLevel: optional('LOG_LEVEL', 'info'),

  // --- Conexion hacia OpenWA ---
  openwa: {
    // Dentro de Docker: http://openwa-api:2785/api
    baseUrl: optional('OPENWA_BASE_URL', 'http://openwa-api:2785/api').replace(/\/+$/, ''),
    apiKey: required('OPENWA_API_KEY'),
    sessionId: required('OPENWA_SESSION_ID'),
    timeoutMs: int('OPENWA_TIMEOUT_MS', 15000),
    retries: int('OPENWA_RETRIES', 2),
  },

  // Secreto HMAC compartido con el webhook registrado en OpenWA.
  // OpenWA exige minimo 16 caracteres al registrarlo.
  webhookSecret: required('WEBHOOK_SECRET'),

  // --- Politica de respuesta ---
  behaviour: {
    // Ignorar mensajes de grupos (recomendado para un bot 1:1).
    ignoreGroups: bool('IGNORE_GROUPS', true),
    // Ignorar los estados / difusiones (status@broadcast).
    ignoreBroadcast: bool('IGNORE_BROADCAST', true),
    // Numeros o JIDs que el bot nunca debe contestar (ej. tu propio equipo).
    blocklist: list('BLOCKLIST'),
    // Si se define, el bot SOLO contesta a estos JIDs. Util para pruebas
    // controladas antes de abrirlo a todos los clientes.
    allowlist: list('ALLOWLIST'),
    // Marcar el chat como leido antes de responder.
    markAsRead: bool('MARK_AS_READ', true),
    // Mostrar "escribiendo..." y esperar antes de enviar, para que no parezca
    // una respuesta instantanea de maquina.
    simulateTyping: bool('SIMULATE_TYPING', true),
    typingMinMs: int('TYPING_MIN_MS', 900),
    typingMaxMs: int('TYPING_MAX_MS', 2200),
    // Responder citando el mensaje original.
    quoteOriginal: bool('QUOTE_ORIGINAL', false),
  },

  // --- Anti-flood: protege la cuenta de WhatsApp de un baneo ---
  throttle: {
    // Maximo de respuestas por chat dentro de la ventana.
    maxRepliesPerChat: int('MAX_REPLIES_PER_CHAT', 8),
    windowMs: int('THROTTLE_WINDOW_MS', 60_000),
    // Maximo global de envios por minuto en toda la instancia.
    maxRepliesGlobal: int('MAX_REPLIES_GLOBAL', 20),
  },

  // --- Horario de atencion (zona horaria IANA) ---
  businessHours: {
    enabled: bool('BUSINESS_HOURS_ENABLED', false),
    timezone: optional('BUSINESS_HOURS_TZ', 'America/Mexico_City'),
    // 1 = lunes ... 7 = domingo
    days: list('BUSINESS_HOURS_DAYS', ['1', '2', '3', '4', '5']).map(Number),
    startHour: int('BUSINESS_HOURS_START', 9),
    endHour: int('BUSINESS_HOURS_END', 18),
  },

  // --- Respuestas con IA ---
  // Solo se usa cuando ninguna regla determinista coincide.
  ai: {
    enabled: bool('AI_ENABLED', false),
    // Compatible con cualquier API estilo OpenAI (OpenAI, Azure, Groq, un
    // gateway propio): basta cambiar baseUrl y modelo.
    baseUrl: optional('AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: optional('OPENAI_API_KEY', ''),
    model: optional('AI_MODEL', 'gpt-4.1-mini'),
    maxTokens: int('AI_MAX_TOKENS', 300),
    temperature: Number(optional('AI_TEMPERATURE', '0.3')),
    timeoutMs: int('AI_TIMEOUT_MS', 8000),
    // Recorte de la entrada del usuario antes de pagarla como tokens.
    maxInputChars: int('AI_MAX_INPUT_CHARS', 1000),
    // Deja vacio para usar el prompt por defecto de ai.js.
    systemPrompt: optional('AI_SYSTEM_PROMPT', ''),
  },

  // Cuantas claves de idempotencia recordar para descartar reentregas.
  dedupeSize: int('DEDUPE_SIZE', 5000),
};

// OPENWA_API_KEY y OPENAI_API_KEY se diferencian en dos letras transpuestas.
// Intercambiarlas produce un 401 "Invalid API key" opaco, que parece un
// problema de permisos y cuesta rastrear. Se detecta por el prefijo: las de
// OpenWA empiezan por "owa_" y las de OpenAI por "sk-".
if (config.openwa.apiKey.startsWith('sk-')) {
  throw new Error(
    'OPENWA_API_KEY contiene una clave de OpenAI (empieza por "sk-").\n' +
      '  → OPENWA_API_KEY es la clave del gateway y empieza por "owa_".\n' +
      '  → La clave de OpenAI va en OPENAI_API_KEY.',
  );
}
if (config.ai.apiKey && config.ai.apiKey.startsWith('owa_')) {
  throw new Error(
    'OPENAI_API_KEY contiene una clave de OpenWA (empieza por "owa_").\n' +
      '  → Estan intercambiadas: revisa tambien OPENWA_API_KEY.',
  );
}

// La IA sin clave no falla al vuelo: falla aqui, al arrancar, donde se ve.
if (config.ai.enabled && !config.ai.apiKey) {
  throw new Error(
    'AI_ENABLED=true pero falta OPENAI_API_KEY.\n' +
      '  → Ponla en las variables del stack, nunca en el codigo.',
  );
}
