const UNSUPPORTED_VIDEO_HOSTS = new Set([
  'dtpg.rpmplay.xyz',
  'bysevepoin.com',
  'ok.ru',
  'voe.sx',
  'savefiles.top',
  'mxdrop.to',
  'streamtape.com',
  'mp4upload.com',
  'www.mp4upload.com',
]);

export function isUnsupportedVideoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      UNSUPPORTED_VIDEO_HOSTS.has(host) ||
      host.endsWith('.ok.ru') ||
      host.endsWith('.voe.sx') ||
      host.endsWith('.savefiles.top') ||
      host.endsWith('.mxdrop.to') ||
      host.endsWith('.streamtape.com') ||
      host.endsWith('.mp4upload.com')
    );
  } catch {
    return false;
  }
}
