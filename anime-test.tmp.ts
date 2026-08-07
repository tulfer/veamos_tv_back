import { scrapeAnimejaraDetail } from './src/providers/animejara';
import { scrapeJkanimeDetail } from './src/providers/jkanime';

async function main() {
  const slug = 'the-beginning-after-the-end';
  const log = (m: string) => console.log('  [AJ]', m);
  console.log('=== AnimeJara ===');
  const aj = await scrapeAnimejaraDetail(slug, log);
  if (aj) {
    for (const s of aj.seasons) {
      for (const ep of s.episodes) {
        console.log(`ep${ep.episode_number}:`, ep.videos?.map((v) => `${v.language} [${v.servers.map((sv) => `${sv.name}=${new URL(sv.url).host}${sv.url.slice(-14)}`).join(', ')}]`).join(' | '));
      }
    }
  } else {
    console.log('AnimeJara: null');
  }

  console.log('=== JKAnime ===');
  const jk = await scrapeJkanimeDetail(slug, (m) => console.log('  [JK]', m));
  if (jk) {
    for (const s of jk.seasons) {
      for (const ep of s.episodes) {
        console.log(`ep${ep.episode_number}:`, ep.videos?.map((v) => `${v.language} [${v.servers.map((sv) => `${sv.name}=${new URL(sv.url).host}`).join(', ')}]`).join(' | '));
      }
    }
  } else {
    console.log('JKAnime: null');
  }
  process.exit(0);
}
void main();