import { getRowStrict, setRow } from './store';
import { broadcastRealtime } from './realtime';

/**
 * Versiones de la app habilitadas en /mipanel. Las versiones ACTIVAS son las
 * que pueden registrar dispositivos (POST /v2/:code/device/register con
 * body.version); puede haber más de una activa a la vez. Se guarda en `store`
 * bajo la clave 'app-versions'.
 */

export interface AppVersions {
  activeVersions: string[];
  enabled: string[];
}

const KEY = 'app-versions';

export async function getAppVersions(): Promise<AppVersions> {
  const data = await getRowStrict<AppVersions & { active?: string | null }>(KEY);
  if (!data || typeof data !== 'object') return { activeVersions: [], enabled: [] };
  const activeVersions = Array.isArray(data.activeVersions)
    ? data.activeVersions.filter((v) => typeof v === 'string')
    : typeof data.active === 'string' && data.active
      ? [data.active]
      : [];
  return {
    activeVersions,
    enabled: Array.isArray(data.enabled) ? data.enabled.filter((v) => typeof v === 'string') : [],
  };
}

async function save(cfg: AppVersions): Promise<void> {
  await setRow(KEY, cfg);
  // El panel /mipanel se entera al instante (versión activada/desactivada).
  broadcastRealtime('versions');
}

export function isValidVersion(v: string): boolean {
  return /^\d+(\.\d+)+([-+][0-9A-Za-z.-]+)?$/.test(v.trim());
}

export async function addAppVersion(version: string): Promise<AppVersions> {
  const v = version.trim();
  if (!isValidVersion(v)) throw new Error('Versión inválida (ej: 1.1.5)');
  const cfg = await getAppVersions();
  if (cfg.enabled.includes(v)) throw new Error('La versión ya existe');
  cfg.enabled = [...cfg.enabled, v];
  if (!cfg.activeVersions.length) cfg.activeVersions = [v];
  await save(cfg);
  return cfg;
}

export async function removeAppVersion(version: string): Promise<AppVersions> {
  const cfg = await getAppVersions();
  if (!cfg.enabled.includes(version)) throw new Error('La versión no existe');
  cfg.enabled = cfg.enabled.filter((x) => x !== version);
  cfg.activeVersions = cfg.activeVersions.filter((x) => x !== version);
  await save(cfg);
  return cfg;
}

/** Agrega la versión a la lista de activas (puede haber varias a la vez). */
export async function activateAppVersion(version: string): Promise<AppVersions> {
  const cfg = await getAppVersions();
  if (!cfg.enabled.includes(version)) throw new Error('La versión no existe');
  if (!cfg.activeVersions.includes(version)) {
    cfg.activeVersions = [...cfg.activeVersions, version];
    await save(cfg);
  }
  return cfg;
}

/** Quita la versión de la lista de activas. */
export async function deactivateAppVersion(version: string): Promise<AppVersions> {
  const cfg = await getAppVersions();
  if (!cfg.activeVersions.includes(version)) throw new Error('La versión no está activa');
  cfg.activeVersions = cfg.activeVersions.filter((x) => x !== version);
  await save(cfg);
  return cfg;
}