import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';

const CACHE_TTL = 600_000;

const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function isNetuHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'waaw.to' || host.endsWith('.waaw.to') || host.includes('netu.');
  } catch {
    return false;
  }
}

export interface NetuResolution {
  url: string | null;
  referer?: string;
  cookies?: string;
}

/**
 * Resuelve la URL real del stream (HLS) desde la página embed de netu.
 * El player de netu carga el video vía JavaScript (websocket + hls.js) y las
 * URLs HLS llevan token por IP + expiración, así que:
 *   - la resolución debe hacerse con un navegador real (Playwright)
 *   - la descarga debe ocurrir desde la MISMA IP que resolvió (Cloud Run)
 * Por eso solo funciona donde Playwright esté disponible; en App Hosting
 * devuelve null y el proxy mantiene el comportamiento anterior.
 */
export async function resolveNetuStream(embedUrl: string): Promise<NetuResolution> {
  if (!isNetuHost(embedUrl)) return { url: null };

  const cacheKey = `netu:resolve:${embedUrl}`;
  const cached = memoryCache.get<string>(cacheKey);
  if (cached) {
    return { url: cached || null, referer: new URL(embedUrl).origin };
  }

  const result: NetuResolution = { url: null, referer: new URL(embedUrl).origin };
  try {
    await import('playwright');
    const { launchChromium } = await import('../providers/launch');
    const browser = await launchChromium();
    try {
      const context = await browser.newContext({
        userAgent: STREAM_UA,
        locale: 'es-ES',
      });
      const page = await context.newPage();

      const candidates: string[] = [];
      page.on('response', (response: { url(): string }) => {
        const responseUrl = response.url();
        if (responseUrl.includes('.m3u8') || responseUrl.includes('.m3u') || responseUrl.includes('playlist')) {
          if (!candidates.includes(responseUrl)) {
            candidates.push(responseUrl);
          }
        }
      });

      try {
        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        for (let i = 0; i < 12 && candidates.length === 0; i++) {
          await page.waitForTimeout(1000);
        }
        if (candidates.length === 0) {
          const videoSrc = String(
            await page
              .evaluate(
                '() => { const v = document.querySelector("video"); return v ? (v.currentSrc || v.getAttribute("src") || "") : ""; }',
              )
              .catch(() => ''),
          );
          if (videoSrc && videoSrc.startsWith('http')) {
            candidates.push(videoSrc);
          }
        }
      } catch (error) {
        logger.warn({ error: (error as Error).message, embedUrl }, 'Netu resolver: page load failed');
      }

      const streamUrl = candidates.find((u) => u.includes('.m3u8')) || candidates[0] || null;
      if (streamUrl) {
        const cookies = await context.cookies(embedUrl);
        const cookieHeader = cookies
          .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
          .join('; ');
        result.url = streamUrl;
        if (cookieHeader) result.cookies = cookieHeader;
        logger.info({ embedUrl: embedUrl.substring(0, 120), streamUrl: streamUrl.substring(0, 160) }, 'Netu resolver: stream resuelto');
      } else {
        logger.warn({ embedUrl }, 'Netu resolver: no se encontró stream HLS');
      }

      await context.close().catch(() => {});
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message, embedUrl }, 'Netu resolver: Playwright no disponible o falló');
  }

  memoryCache.set(cacheKey, result.url || '', CACHE_TTL);
  return result;
}
