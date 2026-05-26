import { fetchHTML } from '../utils/http';
import { logger } from '../utils/logger';
import { memoryCache } from '../cache/memory';
import { LiveChannel } from '../types';
import { httpClient } from '../utils/http';

const M3U_SOURCES = [
  'https://iptv-org.github.io/iptv/countries/co.m3u',
  'https://iptv-org.github.io/iptv/countries/mx.m3u',
  'https://iptv-org.github.io/iptv/countries/es.m3u',
  'https://iptv-org.github.io/iptv/countries/ar.m3u',
  'https://iptv-org.github.io/iptv/index.country.m3u',
];

const VALIDATION_TIMEOUT = 4000;

export interface M3UParsedChannel {
  title: string;
  logo?: string;
  group?: string;
  url: string;
  country?: string;
}

export function parseM3U(content: string, country?: string): M3UParsedChannel[] {
  const channels: M3UParsedChannel[] = [];
  const lines = content.split('\n');
  let currentMeta: Partial<M3UParsedChannel> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXTINF:')) {
      currentMeta = {};
      const logoMatch = trimmed.match(/tvg-logo="([^"]*)"/);
      if (logoMatch?.[1]?.startsWith('http')) currentMeta.logo = logoMatch[1];
      const groupMatch = trimmed.match(/group-title="([^"]*)"/);
      if (groupMatch) currentMeta.group = groupMatch[1];
      const title = trimmed.split(',')[1]?.trim();
      if (title) currentMeta.title = title;
      currentMeta.country = country;
    } else if (trimmed.startsWith('http') && currentMeta.title) {
      channels.push({
        title: currentMeta.title,
        logo: currentMeta.logo,
        group: currentMeta.group,
        url: trimmed,
        country: currentMeta.country,
      });
      currentMeta = {};
    }
  }

  return channels;
}

async function validateStreamUrl(url: string): Promise<boolean> {
  try {
    const response = await httpClient.get(url, {
      timeout: VALIDATION_TIMEOUT,
      responseType: 'stream',
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Icy-MetaData': '1' },
      validateStatus: (status) => true,
    });
    response.data.destroy();

    if (response.status === 200 || response.status === 206) return true;
    if (response.status === 302 || response.status === 301) return true;
    if (response.status === 404 || response.status === 410) return false;
    if (response.status >= 400) return false;

    return true;
  } catch (error: any) {
    if (error?.code === 'ECONNABORTED') return false;
    if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED' || error?.code === 'ENETUNREACH') return false;
    return true;
  }
}

export async function validateBatch(batch: LiveChannel[]): Promise<LiveChannel[]> {
  const results = await Promise.allSettled(batch.map(async (ch) => {
    const online = await validateStreamUrl(ch.url || '');
    return { ...ch, online };
  }));
  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<LiveChannel>).value)
    .filter((ch) => ch.online);
}

async function validateChannels(channels: LiveChannel[]): Promise<LiveChannel[]> {
  const validChannels: LiveChannel[] = [];
  const batchSize = 30;

  for (let i = 0; i < channels.length && validChannels.length < 150; i += batchSize) {
    const batch = channels.slice(i, i + batchSize);
    const valid = await validateBatch(batch);
    validChannels.push(...valid);
    logger.info({ batch: i / batchSize + 1, valid: valid.length, accumulated: validChannels.length }, 'Validation batch');
  }

  logger.info({ total: validChannels.length }, 'Channel validation finished');
  return validChannels;
}

function deduplicateChannels(allChannels: M3UParsedChannel[]): M3UParsedChannel[] {
  const unique = new Map<string, M3UParsedChannel>();
  for (const ch of allChannels) {
    const key = ch.title.toLowerCase().trim();
    if (!unique.has(key)) unique.set(key, ch);
  }
  return Array.from(unique.values());
}

const CACHE_KEY = 'live:channels';

export async function fetchLiveChannels(): Promise<LiveChannel[]> {
  const cached = memoryCache.get<LiveChannel[]>(CACHE_KEY);
  if (cached) return cached;

  try {
    const allChannels: M3UParsedChannel[] = [];

    for (const source of M3U_SOURCES) {
      try {
        const country = source.split('/').pop()?.replace('.m3u', '') || undefined;
        const content = await fetchHTML(source);
        const parsed = parseM3U(content, country);
        allChannels.push(...parsed);
      } catch (err) {
        logger.warn({ source, error: err }, 'Failed to fetch M3U source');
      }
    }

    const unique = deduplicateChannels(allChannels);

    const channels: LiveChannel[] = unique.map((ch, idx) => ({
      id: `live_${idx + 1}`,
      title: ch.title,
      logo: ch.logo,
      group: ch.group || 'General',
      url: ch.url,
      country: ch.country?.toUpperCase(),
      type: 'live' as const,
      online: false,
    }));

    if (channels.length === 0) return getFallbackChannels();

    logger.info({ total: channels.length }, 'Validating channels...');
    const valid = await validateChannels(channels);
    logger.info({ valid: valid.length }, 'Validation complete');

    if (valid.length === 0) {
      logger.warn('No valid channels found, using hardcoded fallback');
      return getFallbackChannels();
    }

    memoryCache.set(CACHE_KEY, valid, 900_000);
    return valid;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch live channels');
    return getFallbackChannels();
  }
}

export async function getChannelsByGroup(group: string): Promise<LiveChannel[]> {
  const channels = await fetchLiveChannels();
  return channels.filter((ch) => ch.group?.toLowerCase() === group.toLowerCase());
}

export async function getChannelsByCountry(country: string): Promise<LiveChannel[]> {
  const channels = await fetchLiveChannels();
  return channels.filter((ch) => ch.country?.toLowerCase() === country.toLowerCase());
}

export function getChannelGroups(): string[] {
  const channels = memoryCache.get<LiveChannel[]>(CACHE_KEY);
  if (!channels) return ['General', 'Sports', 'News', 'Entertainment', 'Movies'];
  const groups = new Set(channels.map((ch) => ch.group || 'General').filter(Boolean));
  return Array.from(groups).sort();
}

function getFallbackChannels(): LiveChannel[] {
  return [
    { id: 'live_1', title: 'Caracol TV', logo: 'https://iptv-org.github.io/iptv/logos/caracol-tv.png', group: 'General', country: 'CO', type: 'live', online: true },
    { id: 'live_2', title: 'RCN TV', logo: 'https://iptv-org.github.io/iptv/logos/rcn-tv.png', group: 'General', country: 'CO', type: 'live', online: true },
    { id: 'live_3', title: 'ESPN', logo: 'https://iptv-org.github.io/iptv/logos/espn.png', group: 'Sports', country: 'CO', type: 'live', online: true },
    { id: 'live_4', title: 'Fox Sports', logo: 'https://iptv-org.github.io/iptv/logos/fox-sports.png', group: 'Sports', country: 'CO', type: 'live', online: true },
    { id: 'live_5', title: 'CNN en Español', logo: 'https://iptv-org.github.io/iptv/logos/cnn-espanol.png', group: 'News', country: 'CO', type: 'live', online: true },
    { id: 'live_6', title: 'Discovery Channel', logo: 'https://iptv-org.github.io/iptv/logos/discovery-channel.png', group: 'Entertainment', country: 'CO', type: 'live', online: true },
    { id: 'live_7', title: 'HBO', logo: 'https://iptv-org.github.io/iptv/logos/hbo.png', group: 'Movies', country: 'CO', type: 'live', online: true },
    { id: 'live_8', title: 'Cartoon Network', logo: 'https://iptv-org.github.io/iptv/logos/cartoon-network.png', group: 'Kids', country: 'CO', type: 'live', online: true },
  ];
}
