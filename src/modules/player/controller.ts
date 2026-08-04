import { FastifyRequest, FastifyReply } from 'fastify';

interface Preset {
  id?: string;
  url?: string;
  keyId?: string;
  key?: string;
  embed?: boolean;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function generatePlayerPage(preset: Preset): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🧪 Probador de Canales — Veamos TV</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0c29;color:#e0e0e0;min-height:100vh;padding:1.5rem}
h1{font-size:1.5rem;margin-bottom:1rem;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.toolbar{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem;align-items:center}
.toolbar input[type=text],.toolbar select{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:.6rem .8rem;font-size:.9rem;outline:none}
.toolbar select{flex:1;min-width:280px}
.toolbar select option{background:#1e1b4b;color:#fff}
#search{flex:1;min-width:200px}
.toolbar input[type=text]:focus,.toolbar select:focus{border-color:#667eea}
.btn{padding:.6rem 1.2rem;border:none;border-radius:8px;cursor:pointer;font-size:.9rem;font-weight:600;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.4;cursor:not-allowed}
video{width:100%;max-width:960px;background:#000;border-radius:12px;border:1px solid rgba(255,255,255,.15);display:block}
.status{margin-top:.8rem;padding:.5rem .9rem;border-radius:8px;font-size:.85rem;display:inline-block}
.status.idle{background:rgba(156,163,175,.15);color:#9ca3af}
.status.busy{background:rgba(251,191,36,.15);color:#fbbf24}
.status.ok{background:rgba(52,211,153,.15);color:#34d399}
.status.error{background:rgba(248,113,113,.15);color:#f87171}
.info{margin-top:1rem;background:rgba(255,255,255,.05);border-radius:12px;padding:.8rem 1rem;border:1px solid rgba(255,255,255,.08);max-width:960px}
.info summary{cursor:pointer;font-size:.9rem;color:#a0a0c0;margin-bottom:.4rem}
.row{display:flex;gap:.6rem;align-items:center;margin:.3rem 0;font-size:.8rem}
.row span{flex:0 0 80px;color:#888}
.row input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:#9ae6b4;border-radius:6px;padding:.35rem .5rem;font-family:monospace;font-size:.78rem;outline:none}
.errors{margin-top:.8rem;max-width:960px;font-family:monospace;font-size:.78rem;color:#f87171;max-height:200px;overflow-y:auto}
.errors div{padding:.2rem 0;border-bottom:1px solid rgba(255,255,255,.05);word-break:break-all}
a.back{color:#58a6ff;text-decoration:none;font-size:.85rem;display:inline-block;margin-bottom:1rem}
a.back:hover{text-decoration:underline}
body.embed a.back, body.embed h1, body.embed .toolbar, body.embed .info, body.embed .errors {display:none}
body.embed video{max-width:none;width:100%;height:100vh;border:none;border-radius:0}
body.embed{padding:0;background:#000}
</style>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.min.js"></script>
<script src="https://unpkg.com/shaka-player@4/dist/shaka-player.compiled.min.js" onerror="this.remove()"></script>
</head>
<body${preset.embed ? ' class="embed"' : ''}>
<a class="back" href="/sync/status?code=1992">← Panel de Sincronización</a>
<h1>🧪 Probador de canales DASH / HLS (ClearKey)</h1>
<div class="toolbar">
  <input type="text" id="search" placeholder="🔎 Buscar canal...">
  <select id="channels"><option value="">Cargando canales...</option></select>
  <button class="btn" id="playBtn" onclick="playSelected()" disabled>▶ Reproducir</button>
</div>
<div class="toolbar">
  <input type="text" id="customUrl" placeholder="o URL directa (https://...mpd o .m3u8)">
  <input type="text" id="customKeyId" placeholder="keyId (hex)" style="width:180px">
  <input type="text" id="customKey" placeholder="key (hex)" style="width:180px">
  <button class="btn" onclick="playCustom()">▶ Probar URL</button>
</div>
<video id="video" controls playsinline></video>
<div>
  <span class="status idle" id="status">Sin reproducir</span>
</div>
<details class="info">
  <summary>📋 Manifiesto y claves ClearKey (para copiar)</summary>
  <div class="row"><span>Manifiesto</span><input id="lblManifest" readonly onclick="this.select()"></div>
  <div class="row"><span>keyId</span><input id="lblKeyId" readonly onclick="this.select()"></div>
  <div class="row"><span>key</span><input id="lblKey" readonly onclick="this.select()"></div>
</details>
<div class="errors" id="errors"></div>
<script>
var PRESET = ${safeJson(preset)};
(function () {
  const VIDEO = document.getElementById('video');
  const STATUS = document.getElementById('status');
  const ERRORS = document.getElementById('errors');
  const SELECT = document.getElementById('channels');
  const SEARCH = document.getElementById('search');
  const PLAY_BTN = document.getElementById('playBtn');
  let player = null;
  let channels = [];

  function setStatus(text, cls) {
    STATUS.textContent = text;
    STATUS.className = 'status ' + (cls || 'idle');
  }
  function logError(e) {
    const msg = (e && (e.message || e.detail && e.detail.message || e)) || 'Error desconocido';
    const line = document.createElement('div');
    line.textContent = String(msg);
    ERRORS.prepend(line);
    console.error(e);
  }
  function fillInfo(manifest, drm) {
    document.getElementById('lblManifest').value = manifest;
    document.getElementById('lblKeyId').value = drm && drm.keyId || '';
    document.getElementById('lblKey').value = drm && drm.key || '';
  }
  function ensureProxy(url) {
    if (url.indexOf('/proxy/stream') !== -1) return url;
    if (url.indexOf('http') === 0) return location.origin + '/proxy/stream?url=' + encodeURIComponent(url);
    return url;
  }
  function kindOf(url) {
    if (url.indexOf('.mpd') !== -1) return 'DASH';
    if (url.indexOf('.m3u8') !== -1) return 'HLS';
    return '?';
  }
  function renderSelect(filter) {
    const f = (filter || '').toLowerCase().trim();
    let html = '<option value="">Selecciona un canal...</option>';
    channels.forEach(function (ch) {
      if (f && (ch.title || ch.id).toLowerCase().indexOf(f) === -1) return;
      const kind = kindOf(ch.url);
      const drmTag = ch.drm && ch.drm.type === 'clearkey' ? ' 🔑' : '';
      html += '<option value="' + ch.id + '">' + (ch.title || ch.id) + ' — ' + kind + drmTag + '</option>';
    });
    SELECT.innerHTML = html;
    PLAY_BTN.disabled = channels.length === 0;
  }
  async function loadChannels() {
    try {
      const res = await fetch('/live/channels?all=true&limit=1000', { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      channels = (data.items || []).filter(function (c) { return c && c.url; });
      renderSelect('');
      if (PRESET && PRESET.id) {
        const ch = channels.find(function (c) { return c.id === PRESET.id; });
        if (ch) {
          SELECT.value = ch.id;
          await playChannel(ch);
          return;
        }
        setStatus('⚠ Canal "' + PRESET.id + '" no está en la lista (¿refrescar canales?)', 'error');
      }
    } catch (e) {
      if (STATUS.textContent === 'Sin reproducir') {
        setStatus('❌ No se pudieron cargar los canales', 'error');
      }
      logError(e);
    }
  }
  async function playChannel(ch) {
    ERRORS.innerHTML = '';
    const manifest = ensureProxy(ch.url);
    const drm = ch.drm && ch.drm.type === 'clearkey' ? ch.drm : null;
    fillInfo(manifest, drm);
    setStatus('⏳ Cargando ' + kindOf(manifest) + '...', 'busy');
    try {
      if (player && player.getManifest()) await player.unload();
    } catch (e) {}
    try {
      const clearKeys = {};
      if (drm && drm.keyId && drm.key) clearKeys[drm.keyId] = drm.key;
      player.configure({ drm: { clearKeys } });
    } catch (e) {
      logError(e);
    }
    try {
      await player.load(manifest);
      setStatus('▶ Reproduciendo', 'ok');
    } catch (e) {
      setStatus('❌ No se pudo reproducir el manifiesto', 'error');
      logError(e);
    }
  }
  async function playSelected() {
    const id = SELECT.value;
    if (!id) return;
    const ch = channels.find(function (c) { return c.id === id; });
    if (ch) await playChannel(ch);
  }
  async function playCustom() {
    const url = document.getElementById('customUrl').value.trim();
    if (!url) { setStatus('⚠ Escribe una URL', 'error'); return; }
    const ch = {
      title: 'URL personalizada',
      url: url,
      drm: null,
    };
    const keyId = document.getElementById('customKeyId').value.trim();
    const key = document.getElementById('customKey').value.trim();
    if (keyId && key) ch.drm = { type: 'clearkey', keyId: keyId, key: key };
    await playChannel(ch);
  }

  async function init() {
    if (!window.shaka) {
      setStatus('❌ shaka-player no cargó (revisa conexión al CDN)', 'error');
      return;
    }
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      setStatus('❌ Este navegador no soporta MSE/EME', 'error');
      return;
    }
    player = new shaka.Player();
    player.addEventListener('error', function (ev) {
      logError(ev.detail);
      setStatus('❌ Error de reproducción', 'error');
    });
    try {
      await player.attach(VIDEO);
    } catch (e) {
      logError(e);
    }
    VIDEO.addEventListener('playing', function () { setStatus('▶ Reproduciendo', 'ok'); });
    VIDEO.addEventListener('waiting', function () { setStatus('⏳ Buffering...', 'busy'); });
    VIDEO.addEventListener('pause', function () { setStatus('⏸ En pausa', 'idle'); });
    VIDEO.addEventListener('stalled', function () { setStatus('⏳ Sin datos...', 'busy'); });
    if (PRESET && PRESET.url) {
      document.getElementById('customUrl').value = PRESET.url;
      document.getElementById('customKeyId').value = PRESET.keyId || '';
      document.getElementById('customKey').value = PRESET.key || '';
      await playCustom();
      loadChannels();
      return;
    }
    await loadChannels();
  }
  SEARCH.addEventListener('input', function () { renderSelect(SEARCH.value); });
  init();
})();
</script>
</body>
</html>`;
}

export async function playerHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as { id?: string; url?: string; keyId?: string; key?: string; embed?: string };
  const preset: Preset = {
    id: typeof query.id === 'string' ? query.id : undefined,
    url: typeof query.url === 'string' ? query.url : undefined,
    keyId: typeof query.keyId === 'string' ? query.keyId : undefined,
    key: typeof query.key === 'string' ? query.key : undefined,
    embed: query.embed === '1',
  };
  return reply.type('text/html').send(generatePlayerPage(preset));
}
