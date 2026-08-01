import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Firma/verifica el header `Cookie` que el proxy de streaming debe reenviar.
 *
 * El reproductor del proveedor (p. ej. el JS de cablevisionhd/tvporinternet2)
 * fija cookies en el contexto del navegador que el m3u8 puede exigir. La
 * extracción con Playwright las captura y las empaqueta en un token cifrado
 * (AES-256-GCM con clave derivada de JWT_SECRET) que va en la URL del proxy.
 *
 * Es stateless: cualquier instancia (App Hosting o Cloud Run) que comparta
 * JWT_SECRET puede descifrarlo, sin depender de un store en memoria (que se
 * rompería con varias instancias).
 */

function getKey(): Buffer {
  return crypto.createHash('sha256').update(env.JWT_SECRET).digest();
}

export function signCookies(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([cipher.update(cookieHeader, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
  } catch {
    return null;
  }
}

export function verifyCookies(token: string | undefined | null): string | null {
  if (!token) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 28) return null; // iv(12) + tag(16)
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}
