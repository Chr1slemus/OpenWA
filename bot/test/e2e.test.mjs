import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = 'test-secret-de-32-caracteres-ok!!';
const MOCK_PORT = 4599;
const BOT_PORT = 4600;

// ---- OpenWA simulado: registra cada llamada que recibe ----
const calls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ path: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messageId: 'msg-' + calls.length, timestamp: 1 }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

// ---- Arrancar el bot ----
process.env.PORT = String(BOT_PORT);
process.env.OPENWA_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/api`;
process.env.OPENWA_API_KEY = 'k'.repeat(32);
process.env.OPENWA_SESSION_ID = 'test-session';
process.env.WEBHOOK_SECRET = SECRET;
process.env.SIMULATE_TYPING = 'false';
process.env.LOG_LEVEL = 'error';
await import('../src/server.js');
await new Promise((r) => setTimeout(r, 400));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

function post(payload, { signed = true, key } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (signed) {
    headers['X-OpenWA-Signature'] =
      'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  }
  headers['X-OpenWA-Idempotency-Key'] = key ?? crypto.randomUUID();
  return fetch(`http://127.0.0.1:${BOT_PORT}/webhook`, { method: 'POST', headers, body: raw });
}

function msg(overrides = {}) {
  return {
    event: 'message.received',
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    idempotencyKey: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    data: {
      id: 'wamid.' + crypto.randomUUID(),
      from: '5215512345678@c.us',
      chatId: '5215512345678@c.us',
      to: '5219998887777@c.us',
      body: 'hola',
      type: 'chat',
      fromMe: false,
      isGroup: false,
      hasMedia: false,
      contact: { name: 'Chris Lemus', pushName: 'Chris' },
      ...overrides,
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 350));
const sends = () => calls.filter((c) => c.path.includes('send-text'));

console.log('\n--- Verificacion de firma ---');
let r = await post(msg(), { signed: false });
check('sin firma -> 401', r.status === 401, `(recibido ${r.status})`);

r = await fetch(`http://127.0.0.1:${BOT_PORT}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': 'sha256=' + 'a'.repeat(64) },
  body: JSON.stringify(msg()),
});
check('firma incorrecta -> 401', r.status === 401, `(recibido ${r.status})`);

console.log('\n--- Flujo feliz ---');
calls.length = 0;
r = await post(msg());
check('firma valida -> 200', r.status === 200, `(recibido ${r.status})`);
await settle();
check('envio una respuesta', sends().length === 1, `(envios: ${sends().length})`);
check('la respuesta es el menu', sends()[0]?.body?.text?.includes('dejo de crecer'));
check(
  'saluda por el nombre',
  sends()[0]?.body?.text?.includes('Hola, Chris'),
  `(texto: ${JSON.stringify(sends()[0]?.body?.text?.slice(0, 40))})`,
);
check('marco como leido', calls.some((c) => c.path.includes('/chats/read')));

console.log('\n--- Idempotencia ---');
calls.length = 0;
const dupKey = 'dup-key-1';
const dupPayload = msg({ body: 'menu' });
await post(dupPayload, { key: dupKey });
await settle();
const afterFirst = sends().length;
r = await post(dupPayload, { key: dupKey });
const dupJson = await r.json();
await settle();
check('reentrega marcada como duplicada', dupJson.duplicate === true);
check('no reenvio el mensaje', sends().length === afterFirst, `(${afterFirst} -> ${sends().length})`);

console.log('\n--- Filtros ---');
calls.length = 0;
await post(msg({ fromMe: true, body: 'hola' }));
await settle();
check('ignora mensajes propios (fromMe)', sends().length === 0, `(envios: ${sends().length})`);

await post(msg({ isGroup: true, chatId: '12345@g.us', from: '12345@g.us', body: 'hola' }));
await settle();
check('ignora grupos', sends().length === 0, `(envios: ${sends().length})`);

await post(msg({ chatId: 'status@broadcast', from: 'status@broadcast', body: 'hola' }));
await settle();
check('ignora status@broadcast', sends().length === 0, `(envios: ${sends().length})`);

console.log('\n--- Maquina de estados del menu ---');
calls.length = 0;
const cliente = '5215599998888@c.us';
await post(msg({ chatId: cliente, from: cliente, body: 'hola' }));
await settle();
await post(msg({ chatId: cliente, from: cliente, body: '1' }));
await settle();
check('opcion 1 pide describir el sintoma', sends()[1]?.body?.text?.includes('Que estas viendo') || sends()[1]?.body?.text?.includes('que estas viendo'));

await settle();


console.log('\n--- Escalamiento a humano ---');
calls.length = 0;
const cli2 = '5215577776666@c.us';
await post(msg({ chatId: cli2, from: cli2, body: 'hola' }));
await settle();
await post(msg({ chatId: cli2, from: cli2, body: '4' }));
await settle();
const antes = sends().length;
await post(msg({ chatId: cli2, from: cli2, body: 'sigo esperando?' }));
await settle();
check('el bot se calla tras pedir asesor', sends().length === antes, `(${antes} -> ${sends().length})`);

console.log('\n--- Limite anti-flood (MAX_REPLIES_PER_CHAT=8) ---');
calls.length = 0;
const flood = '5215511112222@c.us';
for (let i = 0; i < 12; i++) {
  await post(msg({ chatId: flood, from: flood, body: 'menu' }));
  await new Promise((r) => setTimeout(r, 60));
}
await settle();
check('corta a las 8 respuestas', sends().length === 8, `(envios: ${sends().length})`);

console.log('\n--- IA (proveedor simulado) ---');
// Reconfiguramos el modulo de IA en caliente apuntando al mock de OpenAI.
const aiCalls = [];
let aiMode = 'ok';
const aiMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    aiCalls.push(JSON.parse(body));
    if (aiMode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom' }));
    }
    if (aiMode === 'timeout') {
      await new Promise((r) => setTimeout(r, 2000)); // supera AI_TIMEOUT_MS
    }
    const content = aiMode === 'escalate' ? '[ESCALAR]' : 'Claro, con gusto te ayudo con eso.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }));
  });
});
await new Promise((r) => aiMock.listen(4601, r));

const aiCfg = (await import('../src/config.js')).config.ai;
Object.assign(aiCfg, {
  enabled: true,
  baseUrl: 'http://127.0.0.1:4601/v1',
  apiKey: 'sk-test',
  model: 'gpt-4.1-mini',
  timeoutMs: 700,
});

calls.length = 0;
const aiCli = '5215544443333@c.us';
// "necesito algo raro" no coincide con ninguna regla -> cae en la IA.
await post(msg({ chatId: aiCli, from: aiCli, body: 'necesito algo muy especifico' }));
await settle();
check('la IA contesta cuando ninguna regla coincide',
  sends()[0]?.body?.text === 'Claro, con gusto te ayudo con eso.',
  `(${JSON.stringify(sends()[0]?.body?.text)})`);
check('el prompt de sistema prohibe inventar',
  /NO inventes/i.test(aiCalls[0]?.messages?.[0]?.content ?? ''),
  `(${JSON.stringify((aiCalls[0]?.messages?.[0]?.content ?? '').slice(0, 60))})`);

// La IA NO debe usarse cuando una regla si coincide.
const antesDeSaludo = aiCalls.length;
calls.length = 0;
await post(msg({ chatId: '5215500001111@c.us', from: '5215500001111@c.us', body: 'hola' }));
await settle();
check('una regla determinista NO gasta llamada a la IA', aiCalls.length === antesDeSaludo);

// Escalamiento: el modelo devuelve [ESCALAR]
aiMode = 'escalate';
calls.length = 0;
const escCli = '5215566665555@c.us';
// Frase que no coincide con ninguna regla determinista, para que llegue a la IA.
// "cuanto cuesta" ya no sirve: lo atrapa antes la regla de precio, a proposito.
await post(msg({ chatId: escCli, from: escCli, body: 'trabajan tambien los fines de semana' }));
await settle();
check('[ESCALAR] deriva a una persona del equipo',
  sends()[0]?.body?.text?.includes('alguien del equipo'),
  `(${JSON.stringify(sends()[0]?.body?.text)})`);
const antesDeInsistir = sends().length;
await post(msg({ chatId: escCli, from: escCli, body: 'sigues ahi?' }));
await settle();
check('tras escalar, el bot se calla', sends().length === antesDeInsistir);

// Fallos del proveedor: el cliente NUNCA se queda sin respuesta.
aiMode = 'error';
calls.length = 0;
const errCli = '5215577778888@c.us';
await post(msg({ chatId: errCli, from: errCli, body: 'una consulta cualquiera' }));
await settle();
check('si la IA da error, responde el menu',
  sends()[0]?.body?.text?.includes('dejo de crecer'),
  `(${JSON.stringify(sends()[0]?.body?.text?.slice(0, 40))})`);

aiMode = 'timeout';
calls.length = 0;
const toCli = '5215599991111@c.us';
await post(msg({ chatId: toCli, from: toCli, body: 'otra consulta cualquiera' }));
await new Promise((r) => setTimeout(r, 1500));
check('si la IA hace timeout, responde el menu',
  sends()[0]?.body?.text?.includes('dejo de crecer'),
  `(${JSON.stringify(sends()[0]?.body?.text?.slice(0, 40))})`);

aiMode = 'ok';
aiCfg.enabled = false;

console.log('\n--- Marca: nada interno se filtra ---');
const { construirPromptSistema } = await import('../src/brand.js');
const prompt = construirPromptSistema();
const promptBajo = prompt.toLowerCase();

// El documento de marca es confidencial. Estos terminos son juicios internos
// sobre prospectos o cifras de negocio: no deben existir en el prompt, porque
// un modelo con eso en contexto acaba repitiendolo.
const FUGAS = [
  'sabelotodo', 'know-it-all', 'negociador', 'validador', 'politico', 'sonador',
  'anti-cliente', 'anti-customer', 'margen', 'descartar', 'descalifica',
  '5m', '150 empleados', 'segmentacion', 'capataz',
];
const filtradas = FUGAS.filter((t) => promptBajo.includes(t));
check('el prompt no contiene terminos internos', filtradas.length === 0, `(${JSON.stringify(filtradas)})`);

// Palabras que el documento prohibe explicitamente (seccion 3.8 y 4.4).
const PROHIBIDAS = ['innovador', 'disruptiv', 'vanguardia', 'sinergia', 'valor agregado'];
const usadas = PROHIBIDAS.filter((t) => {
  const i = promptBajo.indexOf(t);
  // Aparecen en la lista de prohibiciones, no como descripcion de CGS.
  return i >= 0 && !promptBajo.slice(Math.max(0, i - 220), i).includes('prohibid');
});
check('no describe a CGS con palabras vetadas', usadas.length === 0, `(${JSON.stringify(usadas)})`);

check('prohibe diagnosticar por WhatsApp', /no diagnostiques/i.test(prompt));
check('protege la metodologia', /no expliques como trabajamos/i.test(prompt));
check('prohibe inventar datos', /no inventes/i.test(prompt));
check('define el escalamiento', prompt.includes('[ESCALAR]'));
check('sin precios por defecto', !prompt.includes('20,000'));
check('con precios si se activa',
  construirPromptSistema({ incluirPrecios: true }).includes('20,000'));

console.log('\n--- Marca: estilo del texto deterministico ---');
const { rules: reglas } = await import('../src/rules.js');
// El documento prohibe rayas largas (4.4) y la urgencia comercial.
const textos = [];
for (const chat of ['a@c.us', 'b@c.us', 'c@c.us']) {
  for (const cuerpo of ['hola', 'menu', 'cuanto cuesta', 'gracias']) {
    const r = await (await import('../src/rules.js')).resolveReply({
      chatId: chat, body: cuerpo, text: cuerpo, type: 'chat',
      isGroup: false, senderName: null, messageId: 'x', withinBusinessHours: true,
    });
    if (r.text) textos.push(r.text);
  }
}
check('sin rayas largas (em dash)', !textos.some((t) => /[—–]/.test(t)),
  `(${JSON.stringify(textos.find((t) => /[—–]/.test(t))?.slice(0, 60))})`);
check('sin signos de exclamacion', !textos.some((t) => t.includes('!')));
check('sin urgencia comercial',
  !textos.some((t) => /(aprovecha|tiempo limitado|promocion|descuento)/i.test(t)));
check('el menu ofrece la llamada de diagnostico',
  textos.some((t) => t.includes('Agendar la llamada')));
check('no da cifras de precio', !textos.some((t) => /\d{3},\d{3}|\$\s?\d/.test(t)));

console.log('\n--- Health ---');
r = await fetch(`http://127.0.0.1:${BOT_PORT}/health`);
check('/health responde ok', r.ok && (await r.json()).status === 'ok');

console.log(`\n=====  ${pass} pasaron, ${fail} fallaron  =====\n`);
process.exit(fail === 0 ? 0 : 1);

