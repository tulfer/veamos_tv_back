import { memoryCache } from '../cache/memory';
import { logger } from '../utils/logger';
import { launchChromium } from '../providers/launch';

const CACHE_TTL = 10 * 60_000;
const STREAM_RE = /\.(?:m3u8|mp4|mpd)(?:[?#]|$)|\/manifest(?:[/?]|$)|\/playlist(?:[/?]|$)/i;
const inFlight = new Map<string, Promise<ResolvedEmbed | null>>();

export interface ResolvedEmbed {
  url: string;
  referer: string;
  cookies?: string;
}

function isStreamUrl(url: string, contentType = ''): boolean {
  return STREAM_RE.test(url) || /mpegurl|dash\+xml|video\//i.test(contentType);
}

async function resolveWithBrowser(embedUrl: string): Promise<ResolvedEmbed | null> {
  const browser = await launchChromium();
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    let found: ResolvedEmbed | null = null;

    page.on('response', async (response) => {
      if (found || response.status() >= 400 || !isStreamUrl(response.url(), response.headers()['content-type'] || '')) return;
      const cookies = (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') || undefined;
      found = { url: response.url(), referer: embedUrl, cookies };
    });

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => undefined);
    await page.waitForTimeout(5000);
    await page.locator('video').first().evaluate((video) => (video as unknown as { play?: () => Promise<unknown> }).play?.()).catch(() => undefined);
    await page.waitForTimeout(5000);

    if (!found) {
      const html = await page.content().catch(() => '');
      const match = html.match(/https?:[^"'\s<>]+\.(?:m3u8|mp4|mpd)[^"'\s<>]*/i);
      if (match) found = { url: match[0].replace(/&amp;/g, '&'), referer: embedUrl };
    }
    return found;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function resolveEmbeddedStream(embedUrl: string): Promise<ResolvedEmbed | null> {
  const cached = memoryCache.get<ResolvedEmbed>(`embed:${embedUrl}`);
  if (cached) return cached;
  const running = inFlight.get(embedUrl);
  if (running) return running;

  const task = resolveWithBrowser(embedUrl)
    .then((result) => {
      if (result) memoryCache.set(`embed:${embedUrl}`, result, CACHE_TTL);
      return result;
    })
    .catch((error) => {
      logger.warn({ error: (error as Error).message, embedUrl }, 'No se pudo resolver embed de video');
      return null;
    })
    .finally(() => inFlight.delete(embedUrl));
  inFlight.set(embedUrl, task);
  return task;
}
