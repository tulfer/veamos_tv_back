import axios from 'axios';

export const httpClient = axios.create({
  timeout: 15000,
  headers: {
    // Importante: el CDN de tvporinternet2 (playlist.php) SOLO acepta este
    // User-Agent exacto (Chrome/120). Cualquier otra versión → 403.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/json,*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  },
  maxRedirects: 5,
});

export async function fetchHTML(url: string): Promise<string> {
  const response = await httpClient.get(url);
  return response.data;
}

// ---- Tarro de cookies simple (para sitios tras DDoS-Guard / anti-bot
//      que dan paso cuando el cliente repite las cookies __ddg*) ----

const cookieJar = new Map<string, string>();

function absorbCookies(headers: Record<string, unknown> | undefined): void {
  const setCookie = headers?.['set-cookie'];
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) cookieJar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

export function cookieHeader(): string {
  const parts: string[] = [];
  cookieJar.forEach((value, key) => parts.push(`${key}=${value}`));
  return parts.join('; ');
}

/** GET con el tarro de cookies: una vez que DDoS-Guard da el pase, las
 *  cookies __ddg* se reutilizan en las siguientes peticiones (sin él, el sitio
 *  vuelve a servir el interstitial y el scrape es inestable). */
export async function fetchHTMLWithCookies(url: string, referer?: string): Promise<string> {
  const response = await httpClient.get(url, {
    headers: {
      ...(referer ? { Referer: referer } : {}),
      ...(cookieJar.size ? { Cookie: cookieHeader() } : {}),
    },
  });
  absorbCookies(response.headers);
  return response.data;
}

export async function fetchHTMLWithReferer(url: string, referer: string): Promise<string> {
  const response = await httpClient.get(url, {
    headers: { Referer: referer },
  });
  return response.data;
}

export async function fetchJSON<T>(url: string): Promise<T> {
  const response = await httpClient.get(url, {
    headers: { Accept: 'application/json' },
  });
  return response.data;
}
