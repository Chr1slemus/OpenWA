import express from 'express';
import { config } from './config.js';
import { log } from './logger.js';
import { verifySignature } from './signature.js';
import { Dedupe } from './dedupe.js';
import { handleMessageReceived, handleSessionEvent } from './handler.js';

const app = express();
app.disable('x-powered-by');

const dedupe = new Dedupe(config.dedupeSize);

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/**
 * express.raw() es obligatorio aqui: la firma HMAC de OpenWA se calcula sobre
 * los bytes exactos del cuerpo. Si express.json() lo parseara primero,
 * tendriamos que re-serializar y la firma no coincidiria nunca.
 */
app.post(
  config.webhookPath,
  express.raw({ type: '*/*', limit: '5mb' }),
  (req, res) => {
    const signature = req.get('X-OpenWA-Signature');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!verifySignature(rawBody, signature, config.webhookSecret)) {
      log.warn('Firma de webhook invalida — peticion rechazada', {
        ip: req.ip,
        hasSignature: Boolean(signature),
      });
      return res.status(401).json({ error: 'invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log.warn('Cuerpo de webhook no es JSON valido');
      return res.status(400).json({ error: 'invalid json' });
    }

    const idempotencyKey =
      req.get('X-OpenWA-Idempotency-Key') ?? payload.idempotencyKey ?? payload.deliveryId;

    if (dedupe.check(idempotencyKey)) {
      log.debug('Entrega duplicada descartada', { idempotencyKey });
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // Respondemos YA. OpenWA aborta a los WEBHOOK_TIMEOUT ms (10s por defecto)
    // y reintenta; si procesaramos antes de contestar, un envio lento
    // provocaria reintentos y respuestas duplicadas al cliente.
    res.status(200).json({ ok: true });

    process.nextTick(() => {
      dispatch(payload).catch((error) => {
        log.error('Error no controlado procesando el evento', {
          event: payload?.event,
          error: error.message,
          stack: error.stack,
        });
      });
    });
  },
);

async function dispatch(payload) {
  const event = payload?.event;
  switch (event) {
    case 'message.received':
      return handleMessageReceived(payload);
    case 'session.status':
    case 'session.disconnected':
    case 'session.restriction':
    case 'session.authenticated':
      return handleSessionEvent(payload);
    default:
      log.debug('Evento sin manejador', { event });
      return undefined;
  }
}

// Cualquier otra ruta: 404 silencioso, sin filtrar detalles del servicio.
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info('Bot escuchando', {
    port: config.port,
    webhookPath: config.webhookPath,
    openwa: config.openwa.baseUrl,
    sessionId: config.openwa.sessionId,
    businessHours: config.businessHours.enabled,
  });
});

/**
 * Apagado ordenado: dejamos de aceptar conexiones nuevas y damos margen a las
 * respuestas en vuelo antes de matar el proceso.
 */
function shutdown(signal) {
  log.info('Apagando', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => {
    log.warn('Apagado forzado tras el timeout de gracia');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Promesa rechazada sin manejar', { reason: String(reason) });
});
