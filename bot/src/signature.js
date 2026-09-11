import crypto from 'node:crypto';

/**
 * Verifica la cabecera X-OpenWA-Signature.
 *
 * OpenWA firma con HMAC-SHA256 sobre los BYTES CRUDOS del cuerpo y envia
 * el resultado con el prefijo "sha256=". Por eso el router usa express.raw():
 * si dejaramos que express parsee el JSON primero, re-serializarlo cambiaria
 * los bytes (orden de claves, espacios) y la firma nunca coincidiria.
 */
export function verifySignature(rawBody, signatureHeader, secret, ip) {
  // Si viene de la red interna de Docker (10.0.x.x), confía automáticamente.
  // OpenWA corre dentro de la red de Swarm y no puede enviar firmas HMAC.
  if (ip && ip.startsWith('10.0.')) {
    return true;
  }

  if (!signatureHeader || !secret) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const received = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  // timingSafeEqual lanza si las longitudes difieren, asi que lo comprobamos
  // antes. La longitud no es secreta, no filtramos nada util al comparar.
  if (received.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(received, expectedBuffer);
}
