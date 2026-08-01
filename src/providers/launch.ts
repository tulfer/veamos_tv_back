import { chromium, type Browser } from 'playwright';

/**
 * Lanza Chromium optimizado para contenedores (Cloud Run / Docker):
 * - desactiva el sandbox (en contenedores se ejecuta como root)
 * - evita agotar /dev/shm en contenedores con poca memoria
 * - desactiva GPU (innecesaria en headless)
 */
export async function launchChromium(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}
