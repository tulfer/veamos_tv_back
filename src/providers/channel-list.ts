import * as cheerio from 'cheerio';
import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';

/**
 * Scrapers de listas de canales de los sitios web de TV en vivo. Cada ítem es
 * la PÁGINA del canal (no el stream): la URL del stream se resuelve después
 * con getChannelStream (misma lógica que el refresh por proveedor) y la página
 * queda guardada como refreshUrl del canal.
 */

export interface ScrapeChannelItem {
  title: string;
  logo?: string;
  /** URL de la página del canal (refreshUrl). */
  url: string;
  /** Slug usado por getChannelStream (nombre del archivo/segmento sin extensión). */
  slug: string;
  /** Etiqueta de sección/categoría (Deportes, Regionales, HOME, USA, EVENTOS...). */
  group: string;
}

export interface ScrapeProviderDef {
  id: 'tvenvivo2' | 'tvporinternet2' | 'cablevisionhd' | 'vertvcable';
  label: string;
  base: string;
  sections: { id: string; label: string }[];
}

export const SCRAPE_PROVIDERS: ScrapeProviderDef[] = [
  { id: 'tvenvivo2', label: 'TV En Vivo 2', base: 'https://www.tvenvivo2.com', sections: [{ id: 'home', label: 'Deportes' }, { id: 'shows', label: 'Regionales' }] },
  { id: 'tvporinternet2', label: 'TV por Internet 2', base: 'https://www.tvporinternet2.com', sections: [{ id: 'home', label: 'HOME' }, { id: 'shows', label: 'USA' }] },
  { id: 'cablevisionhd', label: 'CableVision HD', base: 'https://www.cablevisionhd.com', sections: [{ id: 'home', label: 'HOME' }, { id: 'shows', label: 'EVENTOS' }] },
  { id: 'vertvcable', label: 'VerTV Cable', base: 'https://www.vertvcable.com', sections: [] },
];

function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function slugFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/^\//, '').replace(/\/+$/, '');
    return pathname.replace(/\.\w+$/, '');
  } catch {
    return '';
  }
}

/** Tarjetas de los sitios "hermanos" (tvenvivo2, tvporinternet2, cablevisionhd). */
function parseSisterCards(html: string, base: string, sectionLabel: string): ScrapeChannelItem[] {
  const $ = cheerio.load(html);
  const items: ScrapeChannelItem[] = [];
  $('a.channel-card').each((_i, el) => {
    const href = $(el).attr('href') || '';
    if (!href || !sameOrigin(href, base)) return; // descarta anuncios (linktre.online, etc.)
    const title = $(el).find('p').first().text().trim() || $(el).find('img').first().attr('alt')?.trim() || '';
    if (!title) return;
    const src = $(el).find('img').first().attr('src') || '';
    items.push({
      title,
      logo: src && !src.startsWith('data:') ? absUrl(src, base) : undefined,
      url: absUrl(href, base),
      slug: slugFromUrl(href),
      group: sectionLabel,
    });
  });
  return items;
}

/**
 * Sitios "hermanos": las dos secciones viven en la misma página. La sección
 * principal (data-page="home") son las tarjetas de #channels; la segunda
 * (data-page="shows") está en un template literal JS `const showChannels = \`...\`;`.
 */
async function scrapeSisterSite(provider: 'tvenvivo2' | 'tvporinternet2' | 'cablevisionhd', section: string): Promise<ScrapeChannelItem[]> {
  const def = SCRAPE_PROVIDERS.find((p) => p.id === provider)!;
  const sectionDef = def.sections.find((s) => s.id === section) || def.sections[0];
  const html = await fetchHTML(def.base);
  if (sectionDef.id === 'home') {
    return parseSisterCards(html, def.base, sectionDef.label);
  }
  const match = html.match(/const showChannels = `([\s\S]*?)`;/);
  if (!match) {
    logger.warn({ provider }, 'No showChannels template found');
    return [];
  }
  return parseSisterCards(match[1], def.base, sectionDef.label);
}

/** VerTV Cable (WordPress tema appyn): grilla .baps con paginación. */
async function scrapeVertvCable(maxPages = 6): Promise<ScrapeChannelItem[]> {
  const base = SCRAPE_PROVIDERS.find((p) => p.id === 'vertvcable')!.base;
  const items: ScrapeChannelItem[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? base : `${base}/page/${page}/`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const before = items.length;
    $('div.baps .bav a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!href || !sameOrigin(href, base) || seen.has(href)) return;
      const title = $(el).attr('title')?.trim() || $(el).find('.title').first().text().trim() || '';
      if (!title) return;
      const img = $(el).find('img').first();
      const src = img.attr('data-src') || img.attr('src') || '';
      seen.add(href);
      items.push({
        title,
        logo: src && !src.startsWith('data:') ? absUrl(src, base) : undefined,
        url: absUrl(href, base),
        slug: slugFromUrl(href),
        group: 'Canales TV',
      });
    });
    logger.info({ page, found: items.length - before }, 'vertvcable page scraped');
    if (items.length === before) break; // sin canales nuevos → última página
  }
  return items;
}

export async function scrapeChannelList(provider: ScrapeProviderDef['id'], section?: string): Promise<ScrapeChannelItem[]> {
  if (provider === 'vertvcable') return scrapeVertvCable();
  return scrapeSisterSite(provider, section || 'home');
}