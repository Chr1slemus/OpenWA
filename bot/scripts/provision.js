#!/usr/bin/env node
/**
 * Script de alta: crea la sesion de WhatsApp, la arranca, muestra el QR y
 * registra el webhook apuntando al bot.
 *
 * Es idempotente: si la sesion o el webhook ya existen, no los duplica.
 *
 * Uso (desde el VPS, en el directorio bot/):
 *   OPENWA_BASE_URL=http://localhost:2785/api \
 *   OPENWA_API_KEY=... \
 *   OPENWA_SESSION_ID=cgs-main \
 *   WEBHOOK_SECRET=... \
 *   BOT_WEBHOOK_URL=http://cgs-wa-bot:3000/webhook \
 *   node scripts/provision.js
 */

const BASE_URL = (process.env.OPENWA_BASE_URL ?? 'http://localhost:2785/api').replace(/\/+$/, '');
const API_KEY = process.env.OPENWA_API_KEY;
const SESSION_ID = process.env.OPENWA_SESSION_ID ?? 'cgs-main';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.BOT_WEBHOOK_URL ?? 'http://cgs-wa-bot:3000/webhook';

const EVENTS = [
  'message.received',
  'session.status',
  'session.disconnected',
  'session.restriction',
];

if (!API_KEY) fail('Falta OPENWA_API_KEY');
if (!WEBHOOK_SECRET) fail('Falta WEBHOOK_SECRET');
if (WEBHOOK_SECRET.length < 16) fail('WEBHOOK_SECRET debe tener al menos 16 caracteres');

function fail(message) {
  console.error(`\n  ERROR: ${message}\n`);
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

async function main() {
  console.log(`\n→ OpenWA: ${BASE_URL}`);
  console.log(`→ Sesion: ${SESSION_ID}\n`);

  // 1. Crear la sesion si no existe.
  const existing = await api('GET', `/sessions/${encodeURIComponent(SESSION_ID)}`);
  if (existing.ok) {
    console.log(`✓ La sesion ya existe (estado: ${existing.body?.status ?? 'desconocido'})`);
  } else if (existing.status === 404) {
    const created = await api('POST', '/sessions', { name: SESSION_ID });
    if (!created.ok) fail(`No se pudo crear la sesion: ${created.status} ${JSON.stringify(created.body)}`);
    console.log('✓ Sesion creada');
  } else {
    fail(`No se pudo consultar la sesion: ${existing.status} ${JSON.stringify(existing.body)}`);
  }

  // 2. Arrancarla. Si ya estaba arrancada, OpenWA responde con error benigno.
  const started = await api('POST', `/sessions/${encodeURIComponent(SESSION_ID)}/start`);
  console.log(started.ok ? '✓ Sesion arrancada' : `· Arranque omitido (${started.status})`);

  // 3. Registrar el webhook, evitando duplicados por URL.
  const hooks = await api('GET', `/sessions/${encodeURIComponent(SESSION_ID)}/webhooks`);
  const alreadyRegistered =
    Array.isArray(hooks.body?.data ?? hooks.body) &&
    (hooks.body?.data ?? hooks.body).some((hook) => hook.url === WEBHOOK_URL);

  if (alreadyRegistered) {
    console.log(`✓ El webhook ya estaba registrado (${WEBHOOK_URL})`);
  } else {
    const hook = await api('POST', `/sessions/${encodeURIComponent(SESSION_ID)}/webhooks`, {
      url: WEBHOOK_URL,
      events: EVENTS,
      secret: WEBHOOK_SECRET,
      retryCount: 3,
    });
    if (!hook.ok) {
      // El fallo mas comun aqui es el guardia SSRF rechazando una URL interna.
      fail(
        `No se pudo registrar el webhook: ${hook.status} ${JSON.stringify(hook.body)}\n` +
          `  Si es un 400 por SSRF, agrega el host del bot a SSRF_ALLOWED_HOSTS en el .env de OpenWA y reinicia.`,
      );
    }
    console.log(`✓ Webhook registrado → ${WEBHOOK_URL}`);
  }

  // 4. Mostrar el QR si la sesion aun no esta vinculada.
  const status = await api('GET', `/sessions/${encodeURIComponent(SESSION_ID)}`);
  if (status.body?.status !== 'connected' && status.body?.status !== 'ready') {
    console.log('\n→ Escanea el QR desde el dashboard, o consultalo con:');
    console.log(
      `  curl -H "X-API-Key: $OPENWA_API_KEY" ${BASE_URL}/sessions/${SESSION_ID}/qr\n`,
    );
  } else {
    console.log('\n✓ La sesion ya esta conectada a WhatsApp\n');
  }
}

main().catch((error) => fail(error.message));
