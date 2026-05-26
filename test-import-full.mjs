import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const DATA_PATH = path.resolve('data', 'sync-data.json');
const M3U_URL = 'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/refs/heads/main/playlists/roku_all.m3u';

function loadSyncData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return null;
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function saveSyncData(data) {
  try {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (data.channels?.length > 0) {
      fs.writeFileSync(DATA_PATH + '.channels.json', JSON.stringify(data.channels, null, 2), 'utf-8');
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
    console.log('Saved:', DATA_PATH);
  } catch (e) { console.error('Save failed:', e.message); }
}

function parseM3U(content, country) {
  const channels = [];
  const lines = content.split('\n');
  let currentMeta = {};
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
      channels.push({ title: currentMeta.title, logo: currentMeta.logo, group: currentMeta.group, url: trimmed, country: currentMeta.country });
      currentMeta = {};
    }
  }
  return channels;
}

async function validateStreamUrl(url) {
  try {
    const response = await axios.get(url, {
      timeout: 4000,
      responseType: 'stream',
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Icy-MetaData': '1' },
      validateStatus: () => true,
      maxRedirects: 5,
    });
    response.data.destroy();
    if (response.status === 200 || response.status === 206) return true;
    if (response.status === 302 || response.status === 301) return true;
    if (response.status === 404 || response.status === 410) return false;
    if (response.status >= 400) return false;
    return true;
  } catch (error) {
    if (error?.code === 'ECONNABORTED') return false;
    if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED' || error?.code === 'ENETUNREACH') return false;
    console.log('  Unexpected error for', url.substring(0, 50), ':', error.code || error.message);
    return true;
  }
}

async function main() {
  console.log('Fetching M3U...');
  const resp = await axios.get(M3U_URL, { timeout: 15000 });
  const content = resp.data;
  console.log('Fetched OK, length:', content.length);

  const parsed = parseM3U(content, 'ROKU');
  console.log('Parsed channels:', parsed.length);

  const toValidate = parsed.map((ch, idx) => ({
    id: `import_${idx + 1}`,
    title: ch.title,
    logo: ch.logo,
    group: ch.group || 'General',
    url: ch.url,
    country: ch.country?.toUpperCase(),
    type: 'live',
    online: false,
  }));

  console.log('\nValidating channels...');
  const batchSize = 30;
  const valid = [];
  for (let i = 0; i < toValidate.length; i += batchSize) {
    const batch = toValidate.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (ch) => {
      const online = await validateStreamUrl(ch.url || '');
      return { ...ch, online };
    }));
    const batchValid = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(ch => ch.online);
    valid.push(...batchValid);
    console.log(`  Batch ${i/batchSize + 1}: ${batchValid.length} valid (total: ${valid.length})`);
  }

  console.log('\nValid channels:', valid.length);

  if (valid.length === 0) {
    console.log('No valid channels found');
    return;
  }

  const existing = loadSyncData();
  const existingChannels = existing?.channels || [];
  const existingTitles = new Set(existingChannels.map(ch => ch.title.toLowerCase().trim()));

  const newChannels = [];
  let skipped = 0;
  for (const ch of valid) {
    if (existingTitles.has(ch.title.toLowerCase().trim())) {
      skipped++;
    } else {
      ch.id = `live_${existingChannels.length + newChannels.length + 1}`;
      newChannels.push(ch);
    }
  }

  console.log(`New: ${newChannels.length}, Skipped (dupes): ${skipped}`);

  saveSyncData({
    movies: existing?.movies || [],
    series: existing?.series || [],
    channels: [...existingChannels, ...newChannels],
    popularMovies: existing?.popularMovies || [],
    popularSeries: existing?.popularSeries || [],
    updatedAt: Date.now(),
  });

  console.log('Import complete!');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
});
