import { getRowStrict, setRow } from './store';

/**
 * Versiones de la app habilitadas en /mipanel. La versión ACTIVA es la única
 * que puede registrar dispositivos (POST /v2/:code/device/register con
 * body.version). Se guarda en `store` bajo la clave 'app-versions'.
 */

export interface AppVersions {
  active: string | null;
  enabled: string[];
}

const KEY = 'app-versions';

export async function getAppVersions(): Promise<AppVersions> {
  const data = await getRowStrict<AppVersions>(KEY);
  if (!data || typeof data !== 'object') return { active: null, enabled: [] };
  return {
    active: typeof data.active === 'string' ? data.active : null,
    enabled: Array.isArray(data.enabled) ? data.enabled.filter((v) => typeof v === 'string') : [],
  };
}

async function save(cfg: AppVersions): Promise<void> {
  await setRow(KEY, cfg);
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
  if (!cfg.active) cfg.active = v;
  await save(cfg);
  return cfg;
}

export async function removeAppVersion(version: string): Promise<AppVersions> {
  const cfg = await getAppVersions();
  if (!cfg.enabled.includes(version)) throw new Error('La versión no existe');
  cfg.enabled = cfg.enabled.filter((x) => x !== version);
  if (cfg.active === version) cfg.active = null;
  await save(cfg);
  return cfg;
}

export async function activateAppVersion(version: string): Promise<AppVersions> {
  const cfg = await getAppVersions();
  if (!cfg.enabled.includes(version)) throw new Error('La versión no existe');
  cfg.active = version;
  await save(cfg);
  return cfg;
}