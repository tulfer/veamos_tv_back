import { launchChromium } from './launch';
import { logger } from '../utils/logger';

export interface CinebyItem {
  id: number;
  title: string;
  poster: string;
  backdrop?: string;
  rating: number;
  year: number;
  mediaType: 'movie' | 'tv';
  slug: string;
  rank?: number;
  description?: string;
}

export interface SectionData {
  name: string;
  items: CinebyItem[];
}

export interface CinebyHomeData {
  banner: CinebyItem[];
  top10: CinebyItem[];
  tendencias: CinebyItem[];
  tendenciasSeries: CinebyItem[];
  streaming: Record<string, CinebyItem[]>;
  masValorados: CinebyItem[];
  masValoradosSeries: CinebyItem[];
  categories: Record<string, CinebyItem[]>;
  categoriesSeries: Record<string, CinebyItem[]>;
  sections: SectionData[];
  updatedAt: number;
}

const STREAMING_NAMES = ['Netflix', 'Prime Video', 'Max', 'Disney+', 'Apple TV+', 'Paramount+', 'Hulu'];
const TAB_SECTIONS = ['Tendencias', 'Más valorados', 'Mejor valorados', 'Top rated'];

const EXTRACT_FN = `
(function() {
  var result = { sections: [], banner: [] };

  var heroSwiper = document.querySelector('[class*="heroSwiper"]');
  if (heroSwiper) {
    var slides = heroSwiper.querySelectorAll('.swiper-slide');
    slides.forEach(function(slide) {
      var h2 = slide.querySelector('h2');
      var title = h2 ? h2.textContent.trim() : '';
      if (!title) return;
      var img = slide.querySelector('img');
      var poster = img ? (img.getAttribute('src') || '') : '';
      var ratingEl = slide.querySelector('[class*="metaRating"]');
      var rating = ratingEl ? parseFloat(ratingEl.textContent.trim()) : 0;
      var metaItems = slide.querySelectorAll('[class*="metaItem"]');
      var year = 0;
      for (var i = 0; i < metaItems.length; i++) {
        var txt = metaItems[i].textContent.trim();
        var ym = txt.match(/\\b(\\d{4})\\b/);
        if (ym) { year = parseInt(ym[1]); break; }
      }
      var descEl = slide.querySelector('p');
      var description = descEl ? descEl.textContent.trim() : '';
      var playLink = slide.querySelector('a[href*="?play=true"]');
      var href = playLink ? playLink.getAttribute('href') : '';
      var idMatch = href.match(/\\/(\\d+)/);
      var id = idMatch ? parseInt(idMatch[1]) : 0;
      result.banner.push({
        id: id,
        title: title,
        poster: poster,
        backdrop: poster,
        rating: rating,
        year: year,
        mediaType: href.indexOf('/tv/') >= 0 ? 'tv' : 'movie',
        slug: href,
        description: description,
      });
    });
  }

  var containers = document.querySelectorAll('div[data-reveal]');
  containers.forEach(function(c) {
    var h = c.querySelector('[class*="heading-trail"]');
    if (!h) return;
    var rawName = h.textContent ? h.textContent.trim() : '';
    if (!rawName || rawName.length > 60 || rawName.length < 3) return;

    var name = rawName;
    var isStreaming = false;
    var isCategory = false;
    if (rawName.indexOf('Solo en') === 0) {
      var btn = h.querySelector('button span[class*="border"]');
      name = btn && btn.textContent ? btn.textContent.trim() : rawName.replace('Solo en', '').trim();
      isStreaming = true;
    }

    var cards = c.querySelectorAll('a[href*="/movie/"], a[href*="/tv/"]');
    var items = [];
    cards.forEach(function(a) {
      var href = a.getAttribute('href') || '';
      if (href.indexOf('?play=true') >= 0) return;
      var ariaLabel = a.getAttribute('aria-label') || '';
      var img = a.querySelector('img');
      var poster = img ? (img.getAttribute('src') || '') : '';
      var h3 = a.querySelector('h3');
      var title = h3 ? h3.textContent.trim() : ariaLabel;
      if (!title) return;
      var idMatch = href.match(/\\/(\\d+)/);
      if (!idMatch) return;

      var rating = 0;
      var yearNum = 0;
      a.querySelectorAll('.tabular-nums').forEach(function(span) {
        var txt = span.textContent.trim();
        var num = parseFloat(txt);
        if (!isNaN(num)) {
          if (num > 100) { yearNum = num; }
          else if (num > 0 && num <= 10) { rating = num; }
        }
      });

      var rank = 0;
      a.querySelectorAll('[class*="badge"] span, [class*="top"] span').forEach(function(span) {
        var r = parseInt(span.textContent.trim());
        if (!isNaN(r) && r > 0 && r < 100) { rank = r; }
      });

      items.push({
        id: parseInt(idMatch[1]),
        title: title,
        poster: poster,
        rating: rating,
        year: yearNum,
        mediaType: href.indexOf('/tv/') >= 0 ? 'tv' : 'movie',
        slug: href,
        rank: rank > 0 ? rank : 0,
      });
    });

    if (items.length > 0) {
      result.sections.push({
        name: name,
        isStreaming: isStreaming,
        isCategory: isCategory,
        items: items,
      });
    }
  });

  return JSON.stringify(result);
})()
`;

function parseSections(raw: string) {
  const parsed = JSON.parse(raw);
  const sections: { name: string; items: CinebyItem[] }[] = [];

  for (const s of parsed.sections || []) {
    sections.push({ name: s.name, items: s.items });
  }

  return { sections, banner: parsed.banner || [] };
}

export async function scrapeCinebyHome(): Promise<CinebyHomeData> {
  const browser = await launchChromium();
  const startTime = Date.now();
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    logger.info('Loading cineby.sc home page...');
    await page.goto('https://www.cineby.sc/es', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);

    // --- Step 1: Extract banner and initial sections (Movies tab + default provider) ---
    logger.info('Extracting initial sections...');
    const initial = await page.evaluate(EXTRACT_FN);
    const { sections: initialSections, banner } = parseSections(initial as string);

    const homeData: CinebyHomeData = {
      banner,
      top10: [],
      tendencias: [],
      tendenciasSeries: [],
      streaming: {},
      masValorados: [],
      masValoradosSeries: [],
      categories: {},
      categoriesSeries: {},
      sections: [],
      updatedAt: Date.now(),
    };

    // Map initial sections
    for (const s of initialSections) {
      if (s.name === 'TOP 10 Hoy') homeData.top10 = s.items;
      else if (s.name === 'Tendencias') homeData.tendencias = s.items;
      else if (s.name === 'Más valorados' || s.name === 'Mejor valorados' || s.name === 'Top rated') homeData.masValorados = s.items;
      else if (STREAMING_NAMES.includes(s.name)) homeData.streaming[s.name] = s.items;
      else homeData.categories[s.name] = s.items;
      homeData.sections.push({ name: s.name, items: s.items });
    }

    // --- Step 2: Click "Series" tab for sections that have Movies/Series tabs ---
    const dataRevealCount = await page.locator('div[data-reveal]').count();
    logger.info({ count: dataRevealCount }, 'Data-reveal containers found');

    // Find which data-reveal index corresponds to which section name
    const sectionIndices = await page.evaluate(`
      (function() {
        var result = [];
        var containers = document.querySelectorAll('div[data-reveal]');
        containers.forEach(function(c, idx) {
          var h = c.querySelector('[class*="heading-trail"]');
          if (!h) return;
          var rawName = h.textContent ? h.textContent.trim() : '';
          var name = rawName;
          if (rawName.indexOf('Solo en') === 0) {
            var btn = h.querySelector('button span[class*="border"]');
            name = btn && btn.textContent ? btn.textContent.trim() : rawName.replace('Solo en', '').trim();
          }
          result.push({ idx: idx, name: name, hasTabs: !!c.querySelector('.ant-tabs') });
        });
        return JSON.stringify(result);
      })()
    `);
    const sectionMap = JSON.parse(sectionIndices as string) as { idx: number; name: string; hasTabs: boolean }[];

    // For each section with tabs, click the "Series" tab and extract
    for (const sm of sectionMap) {
      if (!sm.hasTabs) continue;
      if (STREAMING_NAMES.includes(sm.name)) continue; // streaming has provider dropdown, not Movies/Series tabs

      logger.info({ section: sm.name, idx: sm.idx }, 'Clicking Series tab');

      const container = page.locator('div[data-reveal]').nth(sm.idx);
      const seriesTab = container.locator('[class*="ant-tabs-tab"] div[role="tab"]:has-text("Series")');
      const tabCount = await seriesTab.count();
      if (tabCount === 0) {
        logger.info({ section: sm.name }, 'No Series tab found');
        continue;
      }

      await page.evaluate(`(function() {
        var containers = document.querySelectorAll('div[data-reveal]');
        var c = containers[${sm.idx}];
        if (!c) return;
        var seriesTab = c.querySelector('[class*="ant-tabs-tab"] div[role="tab"][aria-selected="false"]');
        if (!seriesTab) return;
        seriesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await page.waitForTimeout(3000);

      // Extract items from this container now (Series tab)
      const seriesRaw = await page.evaluate(`
        (function() {
          var containers = document.querySelectorAll('div[data-reveal]');
          var c = containers[${sm.idx}];
          if (!c) return '[]';
          var items = [];
          var cards = c.querySelectorAll('a[href*="/movie/"], a[href*="/tv/"]');
          cards.forEach(function(a) {
            var href = a.getAttribute('href') || '';
            if (href.indexOf('?play=true') >= 0) return;
            var ariaLabel = a.getAttribute('aria-label') || '';
            var img = a.querySelector('img');
            var poster = img ? (img.getAttribute('src') || '') : '';
            var h3 = a.querySelector('h3');
            var title = h3 ? h3.textContent.trim() : ariaLabel;
            if (!title) return;
            var idMatch = href.match(/\\/(\\d+)/);
            if (!idMatch) return;
            var rating = 0, yearNum = 0;
            a.querySelectorAll('.tabular-nums').forEach(function(span) {
              var txt = span.textContent.trim();
              var num = parseFloat(txt);
              if (!isNaN(num)) { if (num > 100) yearNum = num; else if (num > 0 && num <= 10) rating = num; }
            });
            items.push({
              id: parseInt(idMatch[1]), title: title, poster: poster,
              rating: rating, year: yearNum,
              mediaType: href.indexOf('/tv/') >= 0 ? 'tv' : 'movie',
              slug: href, rank: 0,
            });
          });
          return JSON.stringify(items);
        })()
      `);
      const seriesItems: CinebyItem[] = JSON.parse(seriesRaw as string);

      if (seriesItems.length > 0) {
        const seriesLabel = sm.name + '_series';
        if (sm.name === 'Tendencias') homeData.tendenciasSeries = seriesItems;
        else if (sm.name === 'Más valorados' || sm.name === 'Mejor valorados' || sm.name === 'Top rated') homeData.masValoradosSeries = seriesItems;
        else homeData.categoriesSeries[sm.name] = seriesItems;
        homeData.sections.push({ name: seriesLabel, items: seriesItems });
      }
    }

    // --- Step 3: Extract all streaming providers ---
    // Find the streaming section in the page
    const streamingSectionMap = sectionMap.find(sm => STREAMING_NAMES.includes(sm.name));
    if (streamingSectionMap) {
      logger.info({ idx: streamingSectionMap.idx }, 'Opening streaming provider dropdown');

      // Click the provider dropdown button to open listbox
      const openDropdownFn = `(function() {
        var containers = document.querySelectorAll('div[data-reveal]');
        var c = containers[${streamingSectionMap.idx}];
        if (!c) return;
        var btn = c.querySelector('button[aria-label="Select streaming provider"]');
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`;
      await page.evaluate(openDropdownFn);
      await page.waitForTimeout(1000);

      // Get all provider options from the listbox
      const providerOptions = await page.evaluate(`
        (function() {
          var listbox = document.querySelector('[role="listbox"]');
          if (!listbox) return '[]';
          var options = [];
          listbox.querySelectorAll('button[role="option"]').forEach(function(btn) {
            var text = btn.querySelector('.flex-1')?.textContent?.trim() || btn.textContent?.trim() || '';
            if (text) options.push(text);
          });
          return JSON.stringify(options);
        })()
      `);
      const providers: string[] = JSON.parse(providerOptions as string);
      logger.info({ providers }, 'Streaming providers found in dropdown');

      // We already have Netflix items (default). Extract others.
      let isFirst = true;
      for (const provider of providers) {
        if (provider === streamingSectionMap.name) continue; // already have this one

        // Re-open dropdown for each provider after the first
        if (!isFirst) {
          await page.evaluate(openDropdownFn);
          await page.waitForTimeout(1000);
        }
        isFirst = false;

        logger.info({ provider }, 'Selecting streaming provider');

        await page.evaluate(`(function() {
          var listbox = document.querySelector('[role="listbox"]');
          if (!listbox) return;
          var btns = listbox.querySelectorAll('button[role="option"]');
          for (var i = 0; i < btns.length; i++) {
            var text = btns[i].querySelector('.flex-1')?.textContent?.trim() || '';
            if (text === "${provider}") {
              btns[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
              break;
            }
          }
        })()`);
        await page.waitForTimeout(3000);

        const providerRaw = await page.evaluate(`
          (function() {
            var containers = document.querySelectorAll('div[data-reveal]');
            var c = containers[${streamingSectionMap.idx}];
            if (!c) return '[]';
            var items = [];
            var cards = c.querySelectorAll('a[href*="/movie/"], a[href*="/tv/"]');
            cards.forEach(function(a) {
              var href = a.getAttribute('href') || '';
              if (href.indexOf('?play=true') >= 0) return;
              var ariaLabel = a.getAttribute('aria-label') || '';
              var img = a.querySelector('img');
              var poster = img ? (img.getAttribute('src') || '') : '';
              var h3 = a.querySelector('h3');
              var title = h3 ? h3.textContent.trim() : ariaLabel;
              if (!title) return;
              var idMatch = href.match(/\\/(\\d+)/);
              if (!idMatch) return;
              var rating = 0, yearNum = 0;
              a.querySelectorAll('.tabular-nums').forEach(function(span) {
                var txt = span.textContent.trim();
                var num = parseFloat(txt);
                if (!isNaN(num)) { if (num > 100) yearNum = num; else if (num > 0 && num <= 10) rating = num; }
              });
              items.push({
                id: parseInt(idMatch[1]), title: title, poster: poster,
                rating: rating, year: yearNum,
                mediaType: href.indexOf('/tv/') >= 0 ? 'tv' : 'movie',
                slug: href, rank: 0,
              });
            });
            return JSON.stringify(items);
          })()
        `);
        const providerItems: CinebyItem[] = JSON.parse(providerRaw as string);
        homeData.streaming[provider] = providerItems;
        homeData.sections.push({ name: provider, items: providerItems });
      }
    }

    logger.info({
      elapsed: Date.now() - startTime,
      sections: homeData.sections.length,
      banner: homeData.banner.length,
      streaming: Object.keys(homeData.streaming).join(','),
    }, 'Cineby home scraped');

    return homeData;
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to scrape cineby home');
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface ItemDetail {
  id: number;
  title: string;
  slug: string;
  mediaType: 'movie' | 'tv';
  description: string;
  videoUrl: string;
  genres: string[];
  originalTitle: string;
  imdbId: string;
}

export async function fetchItemDetails(items: { id: number; mediaType: string; slug: string; title: string }[]): Promise<ItemDetail[]> {
  const results: ItemDetail[] = [];
  const seen = new Set<number>();

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const type = item.mediaType === 'tv' ? 'tv' : 'movie';
    const cleanSlug = item.slug.split('?')[0];
    let data: any = null;

    try {
      const resp = await fetch(`https://db.videasy.net/3/${type}/${item.id}?language=es-ES`);
      if (resp.ok) data = await resp.json();
    } catch { /* continue */ }

    const title = data?.title || data?.name || item.title;
    const originalTitle = data?.original_title || data?.original_name || title;
    const description = data?.overview || '';
    const genres = data?.genres?.map((g: any) => g.name) || [];
    const imdbId = data?.imdb_id || '';

    let videoUrl = '';
    try {
      const browser = await launchChromium();
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      const pg = await ctx.newPage();
      await pg.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => false });`);

      const videoUrlCaptured = new Promise<string>(resolve => {
        const timer = setTimeout(() => resolve(''), 15000);
        pg.on('response', async resp => {
          const url = resp.url();
          if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('embed/') || url.includes('player/')) {
            clearTimeout(timer);
            resolve(url);
          }
        });
        pg.on('framenavigated', frame => {
          const url = frame.url();
          if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('embed/') || url.includes('player/')) {
            clearTimeout(timer);
            resolve(url);
          }
        });
      });

      const pageSlug = cleanSlug.includes('?play=true') ? cleanSlug : `${cleanSlug}?play=true`;
      await pg.goto(`https://www.cineby.sc${pageSlug}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      videoUrl = await videoUrlCaptured;
      await browser.close().catch(() => {});
    } catch { /* playwright not available */ }

    results.push({
      id: item.id,
      title,
      slug: item.slug,
      mediaType: type as 'movie' | 'tv',
      description,
      videoUrl,
      genres,
      originalTitle,
      imdbId,
    });
  }

  return results;
}

export async function saveCinebyHomeData(data: CinebyHomeData): Promise<void> {
  const { saveHomeData } = await import('../services/data-store');
  const { sections, ...rest } = data;
  await saveHomeData(rest as unknown as Record<string, unknown>);
  logger.info('Cineby home data saved to Firestore');
}
