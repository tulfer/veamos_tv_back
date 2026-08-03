/**
 * Página "Explorador de Base de Datos" — cliente estilo Firestore Console
 * para la tabla `store` (key -> jsonb) de Supabase.
 *
 * Permite: listar colecciones/documentos, navegar el árbol jsonb, buscar
 * (texto o campo=valor), editar/agregar/duplicar/eliminar campos, edición
 * JSON cruda y descarga del JSON.
 */

export function generateDbExplorerPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Explorador de BD — Veamos TV</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:#0f0c29;color:#e0e0e0;min-height:100vh}
header{display:flex;align-items:center;gap:1rem;padding:.9rem 1.4rem;
  background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;z-index:10}
header h1{font-size:1.2rem;background:linear-gradient(135deg,#667eea,#764ba2);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;flex:1}
header a{color:#a0a0c0;text-decoration:none;font-size:.85rem;padding:.35rem .7rem;border-radius:6px;border:1px solid rgba(255,255,255,.12)}
header a:hover{border-color:#667eea;color:#fff}
.layout{display:flex;height:calc(100vh - 57px)}
.sidebar{width:280px;min-width:280px;background:rgba(255,255,255,.03);border-right:1px solid rgba(255,255,255,.08);
  display:flex;flex-direction:column;padding:.8rem;gap:.6rem;overflow:hidden}
.sidebar h2{font-size:.8rem;color:#8080a0;text-transform:uppercase;letter-spacing:.05em}
#colSearch{width:100%;padding:.5rem;border-radius:6px;border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.05);color:#fff;font-size:.85rem}
#colSearch:focus{outline:none;border-color:#667eea}
#colList{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.3rem}
.col-item{display:flex;flex-direction:column;gap:.15rem;padding:.5rem .6rem;border-radius:8px;cursor:pointer;
  border:1px solid transparent;font-size:.85rem}
.col-item:hover{background:rgba(255,255,255,.06)}
.col-item.active{background:rgba(102,126,234,.18);border-color:rgba(102,126,234,.5)}
.col-name{font-family:'Consolas','Courier New',monospace;color:#82aaff;word-break:break-all}
.col-meta{font-size:.72rem;color:#8080a0;display:flex;gap:.6rem;flex-wrap:wrap}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.toolbar{display:flex;align-items:center;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap}
.crumb{font-family:'Consolas','Courier New',monospace;font-size:.85rem;color:#a0a0c0;flex:1;word-break:break-all}
.crumb b{color:#82aaff;font-weight:600}
.btn{padding:.45rem .8rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);
  color:#fff;font-size:.8rem;cursor:pointer}
.btn:hover{border-color:#667eea}
.btn.primary{background:linear-gradient(135deg,#667eea,#764ba2);border:none}
.btn.danger:hover{border-color:#f87171;color:#f87171}
.btn:disabled{opacity:.5;cursor:not-allowed}
.querybar{display:flex;align-items:center;gap:.6rem;padding:.6rem 1rem;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap}
.querybar input[type=text]{flex:1;min-width:220px;padding:.5rem;border-radius:6px;border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.05);color:#fff;font-size:.85rem}
.querybar select{padding:.5rem;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.4);color:#fff;font-size:.8rem}
.tree{flex:1;overflow:auto;padding:.8rem 1rem;font-family:'Consolas','Courier New',monospace;font-size:.82rem}
.tree .empty{color:#555;text-align:center;padding:2rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.row{display:flex;align-items:center;gap:.4rem;padding:.16rem .3rem;border-radius:4px;white-space:nowrap}
.row:hover{background:rgba(255,255,255,.05)}
.row.selected{background:rgba(102,126,234,.22)}
.row .caret{width:14px;color:#888;cursor:pointer;user-select:none;text-align:center}
.row .brace{color:#9e9e9e}
.row .key{color:#82aaff}
.row .key.bold{font-weight:700}
.row .v-str{color:#a5d6a7;cursor:pointer;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .v-num{color:#ffd54f;cursor:pointer}
.row .v-bool{color:#64b5f6;cursor:pointer}
.row .v-null{color:#6b7280;font-style:italic}
.row .v-size{color:#8080a0;font-size:.75rem}
.row .actions{display:none;gap:.2rem;margin-left:.3rem}
.row:hover .actions{display:inline-flex}
.row .act{padding:0 .3rem;border:none;background:none;color:#a0a0c0;cursor:pointer;font-size:.85rem;border-radius:4px}
.row .act:hover{background:rgba(255,255,255,.1);color:#fff}
.children{margin-left:1.5rem;border-left:1px solid rgba(255,255,255,.08);padding-left:.3rem}
.children.hidden{display:none}
.match-hl{background:rgba(255,215,79,.15);border-radius:3px}
.row .edit-input{background:#0d1117;border:1px solid #667eea;border-radius:4px;color:#fff;
  font-family:'Consolas','Courier New',monospace;font-size:.82rem;padding:.15rem .35rem}
#statusBar{padding:.45rem 1rem;border-top:1px solid rgba(255,255,255,.08);font-size:.78rem;color:#8080a0;
  display:flex;gap:1rem;align-items:center}
#statusBar .ok{color:#34d399}
#statusBar .err{color:#f87171}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:#1e1b4b;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:1.2rem;width:560px;max-width:92vw;max-height:86vh;overflow:auto}
.modal h3{margin-bottom:.8rem;font-size:1rem;color:#a0a0c0}
.modal label{display:block;font-size:.8rem;color:#aaa;margin-bottom:.3rem}
.modal input[type=text],.modal textarea{width:100%;padding:.5rem;border-radius:6px;border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.05);color:#fff;font-size:.85rem;font-family:'Consolas','Courier New',monospace}
.modal textarea{min-height:180px;resize:vertical}
.modal .modal-actions{display:flex;gap:.7rem;margin-top:.9rem;justify-content:flex-end}
.modal .hint{font-size:.75rem;color:#888;margin-top:.3rem}
#toast{position:fixed;bottom:2rem;right:2rem;padding:.7rem 1.2rem;border-radius:8px;font-size:.85rem;z-index:200;
  background:rgba(52,211,153,.15);border:1px solid #34d399;color:#34d399;opacity:0;transition:opacity .25s}
#toast.err{background:rgba(248,113,113,.15);border-color:#f87171;color:#f87171}
#toast.show{opacity:1}
#queryCount{margin-left:auto;font-size:.75rem;color:#8080a0}
</style>
</head>
<body>
<header>
  <h1>🗄️ Explorador de Base de Datos — Veamos TV</h1>
  <a href="/sync/status?code=1992">🔄 Panel de Sincronización</a>
  <a href="/">🏠 Home</a>
</header>
<div class="layout">
  <aside class="sidebar">
    <h2>Colecciones / Documentos</h2>
    <input type="text" id="colSearch" placeholder="Buscar colección...">
    <div id="colList"><div class="empty" style="padding:1rem">Cargando...</div></div>
  </aside>
  <main class="main">
    <div class="toolbar">
      <span class="crumb" id="crumb">Selecciona una colección</span>
      <button class="btn primary" id="btnReload" disabled onclick="reloadCollection()">🔄 Recargar</button>
      <button class="btn" id="btnDownload" disabled onclick="downloadJson()">⬇️ JSON</button>
      <button class="btn" id="btnCopyPath" disabled onclick="copySelectedPath()">📋 Copiar ruta</button>
      <button class="btn" id="btnAddField" disabled onclick="addFieldToSelected()">➕ Campo</button>
      <button class="btn" id="btnAddItem" disabled onclick="addItemToSelected()">🧩 Ítem</button>
      <button class="btn danger" id="btnDeleteCol" disabled onclick="deleteCollection()">🗑 Colección</button>
    </div>
    <div class="querybar">
      <input type="text" id="queryInput" placeholder='Buscar: texto libre  ·  campo=valor (exacto)  ·  campo:valor (contiene)'>
      <select id="queryMode" onchange="applyQuery()">
        <option value="text">Texto libre</option>
        <option value="eq">campo=valor</option>
        <option value="ct">campo:valor</option>
      </select>
      <button class="btn" onclick="clearQuery()">✖ Limpiar</button>
      <span id="queryCount"></span>
    </div>
    <div class="tree" id="tree"><div class="empty">🗄️ Elige una colección del panel izquierdo para explorar sus datos.</div></div>
    <div id="statusBar"><span id="statusText">Sin operaciones aún</span></div>
  </main>
</div>
<div id="toast"></div>

<script>
var ADMIN_CODE = new URLSearchParams(location.search).get('code') || '';
var state = {
  collections: [],
  currentKey: null,
  data: null,
  selected: null,
  expanded: {},
  query: '',
  mode: 'text',
  matches: 0
};

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function pathKey(p) { return JSON.stringify(p); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._h);
  toast._h = setTimeout(function () { t.className = ''; }, 3200);
}
function setStatus(msg, ok) {
  var s = $('statusText');
  s.textContent = msg;
  s.className = ok === false ? 'err' : (ok === true ? 'ok' : '');
}
function apiGet(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
function apiMutate(method, url, body) {
  return fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json', 'x-admin-code': ADMIN_CODE },
    body: JSON.stringify(body || {})
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  });
}

/* ---------- Colecciones ---------- */

function loadCollections() {
  apiGet('/db/collections').then(function (list) {
    state.collections = list;
    renderCollections();
  }).catch(function (err) {
    $('colList').innerHTML = '<div class="empty" style="padding:1rem">Error cargando: ' + err.message + '</div>';
  });
}

function renderCollections() {
  var q = $('colSearch').value.trim().toLowerCase();
  var list = $('colList');
  list.innerHTML = '';
  var shown = 0;
  state.collections.forEach(function (c) {
    if (q && c.key.toLowerCase().indexOf(q) === -1) return;
    shown++;
    var item = el('div', 'col-item' + (c.key === state.currentKey ? ' active' : ''));
    var name = el('span', 'col-name', c.key);
    var meta = el('span', 'col-meta');
    var bits = [];
    if (c.count != null) bits.push(c.count + ' ítems');
    var sz = fmtBytes(c.sizeBytes);
    if (sz) bits.push(sz);
    if (c.type === 'array') bits.push('[]');
    else if (c.type === 'object') bits.push('{}');
    bits.push(c.updatedAt || '');
    meta.textContent = bits.join(' · ');
    item.appendChild(name);
    item.appendChild(meta);
    item.addEventListener('click', function () { selectCollection(c.key); });
    list.appendChild(item);
  });
  if (shown === 0) {
    list.appendChild(el('div', 'empty', 'Sin coincidencias'));
  }
}

function selectCollection(key) {
  state.currentKey = key;
  state.selected = null;
  state.expanded = {};
  state.query = '';
  $('queryInput').value = '';
  $('queryCount').textContent = '';
  renderCollections();
  $('btnReload').disabled = false;
  $('btnDownload').disabled = false;
  $('btnDeleteCol').disabled = false;
  setStatus('Cargando ' + key + '...');
  apiGet('/db/collection/' + encodeURIComponent(key)).then(function (data) {
    state.data = data;
    setStatus(key + ' cargado (' + sizeOf(data) + ')', true);
    render();
  }).catch(function (err) {
    setStatus('Error cargando ' + key + ': ' + err.message, false);
    toast('Error: ' + err.message, true);
  });
}

function sizeOf(v) {
  try { return fmtBytes(JSON.stringify(v).length); } catch (e) { return ''; }
}

function reloadCollection() {
  if (!state.currentKey) return;
  selectCollection(state.currentKey);
}

/* ---------- Query ---------- */

function applyQuery() {
  state.query = $('queryInput').value.trim().toLowerCase();
  state.mode = $('queryMode').value;
  state.matches = 0;
  render();
}
function clearQuery() {
  $('queryInput').value = '';
  state.query = '';
  state.matches = 0;
  render();
}
$('queryInput').addEventListener('input', applyQuery);

function rawMatches(key, value) {
  if (key && String(key).toLowerCase().indexOf(state.query) !== -1) return true;
  if (value !== null && value !== undefined) {
    var s = (typeof value === 'string') ? value : safeStringify(value);
    return s.toLowerCase().indexOf(state.query) !== -1;
  }
  return String(value).toLowerCase().indexOf(state.query) !== -1;
}
function safeStringify(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function subtreeMatches(key, value) {
  if (state.mode !== 'text') return false;
  if (rawMatches(key, value)) return true;
  if (value && typeof value === 'object') {
    var keys = Array.isArray(value) ? value.map(function (_, i) { return i; }) : Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (subtreeMatches(keys[i], value[keys[i]])) return true;
    }
  }
  return false;
}
function eqItemMatches(item) {
  var eqIdx = state.query.indexOf('=');
  var ctIdx = state.query.indexOf(':');
  var splitAt = state.mode === 'eq' ? eqIdx : ctIdx;
  if (splitAt <= 0) return rawMatches(null, item);
  var field = state.query.slice(0, splitAt).trim();
  var wanted = state.query.slice(splitAt + 1);
  if (!field || item == null || typeof item !== 'object') return false;
  var v = item[field];
  if (v === undefined) return false;
  var s = String(v).toLowerCase();
  return state.mode === 'eq' ? s === wanted : s.indexOf(wanted.toLowerCase()) !== -1;
}

/* ---------- Render ---------- */

function render() {
  var tree = $('tree');
  tree.innerHTML = '';
  if (state.data === null) return;
  renderNode(state.data, [], null, tree, true);
  var qc = $('queryCount');
  if (state.query) {
    qc.textContent = state.mode === 'text' ? (state.matches + ' coincidencias') : (state.matches + ' ítems filtrados');
  } else {
    qc.textContent = '';
  }
  renderCrumb();
}

function isContainer(v) { return v !== null && typeof v === 'object'; }

function renderNode(value, path, keyLabel, parent, isRoot) {
  var row = el('div', 'row');
  var keyStr = isRoot ? '(raíz)' : String(keyLabel);

  if (isContainer(value)) {
    var isArr = Array.isArray(value);
    var pk = pathKey(path);
    var open = !!state.expanded[pk];
    var hasQuery = !!state.query && state.mode === 'text' && !rawMatches(keyStr, value);
    var caret = el('span', 'caret', open ? '▼' : '▶');
    caret.setAttribute('role', 'button');
    caret.setAttribute('aria-label', open ? 'Contraer' : 'Expandir');
    caret.addEventListener('click', function (e) {
      e.stopPropagation();
      state.expanded[pk] = !state.expanded[pk];
      render();
    });
    row.appendChild(caret);
    if (isRoot) {
      row.appendChild(el('span', 'brace', isArr ? '[array]' : '{objeto}'));
    } else {
      row.appendChild(el('span', 'brace', isArr ? '[' : '{'));
      row.appendChild(el('span', 'key bold', keyStr));
      row.appendChild(el('span', 'brace', isArr ? ']' : '}'));
    }
    row.appendChild(el('span', 'v-size', isArr ? (value.length + ' ítems') : (Object.keys(value).length + ' campos')));
    if (hasQuery) {
      var sq = subtreeMatches(null, value);
      if (!sq) {
        row.classList.add('match-hl');
        state.matches++;
      }
    }
    addRowActions(row, value, path, isArr);
    row.addEventListener('click', function () {
      state.selected = path.slice();
      render();
    });
    parent.appendChild(row);

    if (open) {
      var children = el('div', 'children');
      if (isArr) {
        var filtered = null;
        if (state.query && state.mode !== 'text') {
          filtered = [];
          value.forEach(function (item, i) {
            if (eqItemMatches(item)) {
              filtered.push({ idx: i, item: item });
              state.matches++;
            }
          });
        } else if (state.query && state.mode === 'text') {
          filtered = [];
          value.forEach(function (item, i) {
            if (subtreeMatches(i, item)) {
              filtered.push({ idx: i, item: item });
              state.matches++;
            }
          });
        }
        if (filtered) {
          if (filtered.length === 0) children.appendChild(el('div', 'empty', 'Sin coincidencias'));
          filtered.forEach(function (f) { renderNode(f.item, path.concat(f.idx), f.idx, children, false); });
        } else {
          for (var i = 0; i < value.length; i++) {
            renderNode(value[i], path.concat(i), i, children, false);
          }
        }
        if (!state.query) {
          var addBtn = el('button', 'act', '＋ agregar ítem');
          addBtn.setAttribute('aria-label', 'Agregar ítem al array');
          addBtn.addEventListener('click', function () { addItem(path); });
          var addRow = el('div', 'row');
          addRow.appendChild(el('span', 'caret', ''));
          addRow.appendChild(addBtn);
          children.appendChild(addRow);
        }
      } else {
        Object.keys(value).sort().forEach(function (k) {
          if (state.query && state.mode === 'text' && !subtreeMatches(k, value[k])) return;
          renderNode(value[k], path.concat(k), k, children, false);
        });
        if (!state.query) {
          var addFieldBtn = el('button', 'act', '＋ agregar campo');
          addFieldBtn.setAttribute('aria-label', 'Agregar campo al objeto');
          addFieldBtn.addEventListener('click', function () { addField(path); });
          var addRow2 = el('div', 'row');
          addRow2.appendChild(el('span', 'caret', ''));
          addRow2.appendChild(addFieldBtn);
          children.appendChild(addRow2);
        }
      }
      parent.appendChild(children);
    }
  } else {
    /* primitivo */
    row.appendChild(el('span', 'caret', ''));
    row.appendChild(el('span', 'key', isRoot ? '(valor)' : String(keyLabel)));
    var type = value === null ? 'null' : typeof value;
    var cls = 'v-' + (type === 'string' ? 'str' : type === 'number' ? 'num' : type === 'boolean' ? 'bool' : 'null');
    var display = value === null ? 'null' : String(value);
    var vspan = el('span', cls, display);
    if (display.length > 400) vspan.setAttribute('title', display);
    if (!isRoot && type !== 'null') {
      vspan.setAttribute('role', 'button');
      vspan.setAttribute('aria-label', 'Editar valor');
      vspan.addEventListener('click', function () { startInlineEdit(row, value, path); });
    }
    row.appendChild(vspan);
    addRowActions(row, value, path, false);
    parent.appendChild(row);
    if (state.query && rawMatches(keyLabel, value)) {
      row.classList.add('match-hl');
      state.matches++;
    }
  }
}

function addRowActions(row, value, path, isContainerNode) {
  var wrap = el('span', 'actions');
  function act(title, label, fn) {
    var b = el('button', 'act', label);
    b.setAttribute('aria-label', title);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      fn();
    });
    wrap.appendChild(b);
  }
  act('Editar (JSON crudo)', '✏️', function () { editJson(path, value); });
  if (isContainerNode) {
    if (Array.isArray(value)) act('Agregar ítem', '🧩', function () { addItem(path); });
    else act('Agregar campo', '➕', function () { addField(path); });
  }
  act('Duplicar', '⧉', function () { duplicate(path, value); });
  act('Eliminar', '🗑', function () { confirmDelete(path); });
  act('Copiar valor', '📄', function () {
    navigator.clipboard.writeText(safeStringify(value)).then(function () { toast('Valor copiado'); });
  });
  row.appendChild(wrap);
}

function renderCrumb() {
  var c = $('crumb');
  c.innerHTML = '';
  if (!state.currentKey) { c.textContent = 'Selecciona una colección'; return; }
  var b = el('b', null, state.currentKey);
  c.appendChild(b);
  if (state.selected && state.selected.length) {
    c.appendChild(document.createTextNode(' '));
    var parts = [];
    state.selected.forEach(function (seg, i) {
      var s = el('span', null, (typeof seg === 'number' ? '[' + seg + ']' : '.' + seg));
      c.appendChild(s);
    });
  }
}

/* ---------- Edición ---------- */

function parseJsonOrString(text) {
  var t = text.trim();
  if (!t) return '';
  try { return JSON.parse(t); } catch (e) { return text; }
}

function commitSet(path, value) {
  setStatus('Guardando ' + pathKey(path) + '...');
  return apiMutate('PATCH', '/db/collection/' + encodeURIComponent(state.currentKey), { path: path, value: value })
    .then(function (resp) {
      state.data = resp.value;
      setStatus('✅ Guardado en ' + pathKey(path), true);
      toast('Guardado en ' + state.currentKey);
      render();
    }).catch(function (err) {
      setStatus('❌ Error: ' + err.message, false);
      toast('Error: ' + err.message, true);
      throw err;
    });
}

function startInlineEdit(row, oldValue, path) {
  var vspan = row.querySelector('.v-str, .v-num, .v-bool');
  if (!vspan) return;
  var input;
  if (typeof oldValue === 'boolean') {
    input = el('select', 'edit-input');
    [['true', 'true'], ['false', 'false']].forEach(function (opt) {
      var o = el('option', null, opt[0]);
      o.value = opt[1];
      input.appendChild(o);
    });
    input.value = String(oldValue);
  } else {
    input = el('input', 'edit-input');
    input.type = 'text';
    input.value = String(oldValue);
  }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var raw = input.value.trim();
    var newVal;
    if (typeof oldValue === 'number') {
      newVal = Number(raw);
      if (!isFinite(newVal)) { vspan.textContent = String(oldValue); return; }
    } else if (typeof oldValue === 'boolean') {
      newVal = input.value === 'true';
    } else {
      newVal = raw;
    }
    vspan.textContent = String(newVal);
    commitSet(path, newVal).catch(function () { vspan.textContent = String(oldValue); });
  }
  function cancel() {
    if (done) return;
    done = true;
    vspan.textContent = String(oldValue);
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
  vspan.replaceWith(input);
  input.focus();
}

function openModal(title, fieldsHtml, onOk) {
  var overlay = el('div', 'modal-overlay');
  var modal = el('div', 'modal');
  modal.appendChild(el('h3', null, title));
  var fields = el('div', 'modal-fields');
  fields.innerHTML = fieldsHtml;
  modal.appendChild(fields);
  var actions = el('div', 'modal-actions');
  var btnCancel = el('button', 'btn', 'Cancelar');
  btnCancel.addEventListener('click', function () { overlay.remove(); });
  var btnOk = el('button', 'btn primary', 'Guardar');
  btnOk.addEventListener('click', function () {
    onOk(overlay, modal);
  });
  actions.appendChild(btnCancel);
  actions.appendChild(btnOk);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  return overlay;
}

function editJson(path, value) {
  var initial = JSON.stringify(value, null, 2);
  openModal('Editar JSON — ' + pathKey(path),
    '<label for="mJson">Valor (JSON)</label>' +
    '<textarea id="mJson" spellcheck="false">' + escapeHtml(initial) + '</textarea>' +
    '<div class="hint">Pega JSON válido. Texto sin parsear se guarda como string.</div>',
    function (overlay) {
      var raw = $('mJson').value;
      var parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { parsed = raw.trim() ? raw : ''; }
      overlay.remove();
      commitSet(path, parsed);
    });
}

function addField(containerPath) {
  openModal('Agregar campo en ' + pathKey(containerPath),
    '<label for="mKey">Nombre del campo</label>' +
    '<input type="text" id="mKey" placeholder="ej: rating">' +
    '<label for="mValue">Valor (JSON)</label>' +
    '<textarea id="mValue" spellcheck="false">{}</textarea>' +
    '<div class="hint">El valor se parsea como JSON; si no es JSON válido se guarda como string.</div>',
    function (overlay) {
      var key = $('mKey').value.trim();
      if (!key) { toast('El nombre del campo es obligatorio', true); return; }
      var value = parseJsonOrString($('mValue').value);
      overlay.remove();
      commitSet(containerPath.concat(key), value);
    });
}

function addItem(containerPath) {
  openModal('Agregar ítem al array ' + pathKey(containerPath),
    '<label for="mItem">Valor (JSON)</label>' +
    '<textarea id="mItem" spellcheck="false">{}</textarea>' +
    '<div class="hint">Ítem nuevo al final del array.</div>',
    function (overlay) {
      var value = parseJsonOrString($('mItem').value);
      overlay.remove();
      var node = state.data;
      var ok = true;
      containerPath.forEach(function (seg) {
        if (node != null) node = node[seg];
      });
      var idx = (node && Array.isArray(node)) ? node.length : 0;
      commitSet(containerPath.concat(idx), value);
    });
}

function addFieldToSelected() {
  if (state.selected === null) {
    if (state.currentKey && isContainer(state.data)) { addField([]); }
    else toast('Selecciona un objeto (clic en la fila)', true);
    return;
  }
  var node = nodeAtPath(state.selected);
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) addField(state.selected);
  else if (Array.isArray(node)) addItem(state.selected);
  else toast('Selecciona un objeto o un array', true);
}
function addItemToSelected() {
  if (state.selected === null) {
    if (state.currentKey && Array.isArray(state.data)) { addItem([]); }
    else toast('Selecciona un array', true);
    return;
  }
  var node = nodeAtPath(state.selected);
  if (Array.isArray(node)) addItem(state.selected);
  else toast('Selecciona un array (los ítems se agregan al final)', true);
}

function nodeAtPath(path) {
  var node = state.data;
  for (var i = 0; i < path.length && node != null; i++) node = node[path[i]];
  return node;
}

function duplicate(path, value) {
  if (path.length === 0) { toast('No se puede duplicar la raíz', true); return; }
  var parentPath = path.slice(0, -1);
  var parent = nodeAtPath(parentPath);
  var copy = clone(value);
  if (Array.isArray(parent)) {
    var idx = path[path.length - 1];
    var newIdx = idx + 1;
    var arr = parent.slice();
    arr.splice(newIdx, 0, copy);
    commitSet(parentPath, arr);
  } else if (parent && typeof parent === 'object') {
    var base = String(path[path.length - 1]) + '_copy';
    var key = base;
    var n = 2;
    while (Object.prototype.hasOwnProperty.call(parent, key)) {
      key = base + '_' + n;
      n++;
    }
    commitSet(parentPath.concat(key), copy);
  } else {
    toast('No se puede duplicar aquí', true);
  }
}

function confirmDelete(path) {
  openModal('Eliminar — ' + pathKey(path),
    '<div style="color:#f87171;font-size:.9rem">⚠️ ¿Eliminar este campo/ítem? Esta acción no se puede deshacer.</div>',
    function (overlay) {
      overlay.remove();
      setStatus('Eliminando ' + pathKey(path) + '...');
      apiMutate('DELETE', '/db/collection/' + encodeURIComponent(state.currentKey), { path: path })
        .then(function (resp) {
          state.data = resp.value;
          setStatus('✅ Eliminado ' + pathKey(path), true);
          toast('Eliminado');
          render();
        }).catch(function (err) {
          setStatus('❌ Error: ' + err.message, false);
          toast('Error: ' + err.message, true);
        });
    });
}

function deleteCollection() {
  if (!state.currentKey) return;
  openModal('Eliminar colección completa',
    '<div style="color:#f87171;font-size:.9rem">⚠️ ¿Eliminar TODA la fila <b>' + escapeHtml(state.currentKey) + '</b> de la tabla store? No se puede deshacer.</div>',
    function (overlay) {
      overlay.remove();
      apiMutate('DELETE', '/db/collection/' + encodeURIComponent(state.currentKey), { full: true })
        .then(function () {
          state.currentKey = null;
          state.data = null;
          state.selected = null;
          $('btnReload').disabled = true;
          $('btnDownload').disabled = true;
          $('btnDeleteCol').disabled = true;
          setStatus('✅ Colección eliminada', true);
          toast('Colección eliminada');
          render();
          loadCollections();
        }).catch(function (err) {
          setStatus('❌ Error: ' + err.message, false);
          toast('Error: ' + err.message, true);
        });
    });
}

/* ---------- Utilidades ---------- */

function copySelectedPath() {
  if (!state.currentKey) return;
  var parts = [state.currentKey];
  (state.selected || []).forEach(function (seg) {
    parts.push(typeof seg === 'number' ? '[' + seg + ']' : '.' + seg);
  });
  navigator.clipboard.writeText(parts.join('')).then(function () { toast('Ruta copiada: ' + parts.join('')); });
}

function downloadJson() {
  if (state.currentKey === null || state.data === null) return;
  var blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.currentKey + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 300);
  toast('Descargando ' + state.currentKey + '.json');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateToolbar() {
  var hasSel = state.selected !== null;
  $('btnCopyPath').disabled = !(state.currentKey && (hasSel || state.data !== null));
  $('btnAddField').disabled = !state.currentKey;
  $('btnAddItem').disabled = !state.currentKey;
  $('btnReload').disabled = !state.currentKey;
  $('btnDownload').disabled = !(state.currentKey && state.data !== null);
  $('btnDeleteCol').disabled = !state.currentKey;
}

$('colSearch').addEventListener('input', renderCollections);

setInterval(updateToolbar, 500);

loadCollections();
</script>
</body>
</html>`;
}
