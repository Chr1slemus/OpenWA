import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * Logger JSON de una linea, para que Docker / Loki / CloudWatch lo parseen
 * sin configuracion extra.
 */
function emit(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};

/**
 * Enmascara un JID para no dejar numeros completos en los logs.
 * "5215512345678@c.us" -> "521551***678@c.us"
 */
export function maskJid(jid) {
  if (typeof jid !== 'string') return jid;
  const [user, domain] = jid.split('@');
  if (!user || user.length < 8) return jid;
  return `${user.slice(0, 6)}***${user.slice(-3)}@${domain ?? ''}`;
}
