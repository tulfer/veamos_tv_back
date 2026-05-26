import axios from 'axios';

const url = 'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/refs/heads/main/playlists/roku_all.m3u';

try {
  const resp = await axios.get(url, { timeout: 15000 });
  const content = resp.data;
  console.log('Fetched OK, length:', content.length);

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
    } else if (trimmed.startsWith('http') && currentMeta.title) {
      channels.push({ title: currentMeta.title, logo: currentMeta.logo, group: currentMeta.group, url: trimmed });
      currentMeta = {};
    }
  }
  console.log('Parsed channels:', channels.length);

  // Show unique groups
  const groups = [...new Set(channels.map(c => c.group).filter(Boolean))];
  console.log('Groups:', groups);

  // Test validation of first URL
  if (channels.length > 0) {
    console.log('\nTesting validation of first URL:', channels[0].url);
    try {
      const vresp = await axios.get(channels[0].url, {
        timeout: 4000,
        responseType: 'stream',
        validateStatus: () => true,
        headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Icy-MetaData': '1' },
      });
      vresp.data.destroy();
      console.log('Status:', vresp.status);
    } catch (e) {
      console.log('Validation error:', e.code || e.message);
    }
  }
} catch (e) {
  console.error('Error:', e.message);
}
