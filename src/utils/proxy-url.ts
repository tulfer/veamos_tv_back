import { signCookies } from './cookie-token';

export function buildProxyUrl(target: string, referer?: string, cookies?: string): string {
  const params = new URLSearchParams();
  params.set('url', target);
  if (referer) params.set('referer', referer);
  const token = signCookies(cookies);
  if (token) params.set('cookies', token);
  return `/proxy/stream?${params.toString()}`;
}
