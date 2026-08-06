const UNSUPPORTED_VIDEO_HOSTS = new Set([
  'dtpg.rpmplay.xyz',
  'bysevepoin.com',
  'ok.ru',
  'voe.sx',
]);

export function isUnsupportedVideoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return UNSUPPORTED_VIDEO_HOSTS.has(host) || host.endsWith('.ok.ru') || host.endsWith('.voe.sx');
  } catch {
    return false;
  }
}
