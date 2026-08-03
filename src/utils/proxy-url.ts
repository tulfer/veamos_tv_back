import { signCookies } from './cookie-token';
import { env } from '../config/env';

/** Base pública del backend (sin slash final). Sirve para construir URLs
 *  absolutas de streaming reproducibles desde la app. */
export function getPublicBaseUrl(): string {
  return (env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

const PROXY_PATH = '/proxy/stream?';

/** Garantiza que un proxy URL tenga el host público actual: ``https://veamostv.site/proxy/stream?…``.
 *  Si la URL ya trae otro host o es relativa, la re-escribe. Deja intactas
 *  las que no son del proxy (p.ej. un m3u8 directo). */
export function toPublicProxyUrl(url: string): string {
  const base = getPublicBaseUrl();
  if (!base) return url;
  const idx = url.indexOf(PROXY_PATH);
  if (idx < 0) return url;
  return `${base}${url.slice(idx)}`;
}

export function buildProxyUrl(target: string, referer?: string, cookies?: string): string {
  const params = new URLSearchParams();
  params.set('url', target);
  if (referer) params.set('referer', referer);
  const token = signCookies(cookies);
  if (token) params.set('cookies', token);
  return `/proxy/stream?${params.toString()}`;
}
