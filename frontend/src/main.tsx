import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Job = { status: string; lastRun: number | null; duration?: number; count?: number; error?: string; progress?: { current: number; total?: number; message: string } };
type Status = Record<string, Job>;
type AutoRefresh = { enabled: boolean; providers: Record<string, number>; providerLastRuns: Record<string, number> };
type ProcessDef = { key: string; label: string; route: string; method: string; fields?: string[] };
const providers = ['wsdeportes', 'cablevisionhd', 'tvporinternet2', 'tvenvivo2', 'chatytv', 'senalcolombia', 'vertvcable'];
const processDefs: ProcessDef[] = [
  { key: 'movies', label: 'Películas', route: '/sync/movies', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'series', label: 'Series', route: '/sync/series', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'all', label: 'Todo (Películas + Series)', route: '/sync/all', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'estrenoMovies', label: 'Estrenos Películas', route: '/sync/estrenos/movies', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'estrenoSeries', label: 'Estrenos Series', route: '/sync/estrenos/series', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'channels', label: 'TV en Vivo', route: '/sync/live', method: 'POST' },
  { key: 'popularMovies', label: 'Populares Películas', route: '/sync/popular/movies', method: 'POST' },
  { key: 'popularSeries', label: 'Populares Series', route: '/sync/popular/series', method: 'POST' },
  { key: 'home', label: 'Home cineby.sc', route: '/sync/home-bysc', method: 'POST' },
  { key: 'gnulahdHome', label: 'Home gnulahd', route: '/sync/gnulahd/home', method: 'POST' },
  { key: 'gnulahdMovies', label: 'Gnulahd Películas', route: '/sync/gnulahd/movies', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'gnulahdSeries', label: 'Gnulahd Series', route: '/sync/gnulahd/series', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'gnulahdAnime', label: 'Gnulahd Anime', route: '/sync/gnulahd/anime', method: 'POST', fields: ['pages', 'replace'] },
  { key: 'fetchDetails', label: 'Fetch Details', route: '/sync/fetch-details', method: 'POST' },
  { key: 'refreshAll', label: 'Refresh All Canales', route: '/live/channels/refresh-all', method: 'POST' },
  { key: 'refreshExpired', label: 'Refresh Expired', route: '/live/channels/refresh-expired', method: 'POST' },
  { key: 'importM3U', label: 'Importar M3U', route: '/sync/live/import', method: 'POST', fields: ['m3u'] },
];

function formatDate(value?: number | null) { return value ? new Date(value).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Sin ejecutar'; }
function label(value: string) { return value === 'tvenvivo2' ? 'TVEnVivo2' : value; }

function App() {
  const [status, setStatus] = useState<Status>({});
  const [auto, setAuto] = useState<AutoRefresh>({ enabled: true, providers: {}, providerLastRuns: {} });
  const [logs, setLogs] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => JSON.parse(localStorage.getItem('dashboard:hidden') || '[]'));
  const [order, setOrder] = useState<string[]>(() => JSON.parse(localStorage.getItem('dashboard:order') || '[]'));
  const [selected, setSelected] = useState<ProcessDef | null>(null);
  const [params, setParams] = useState<Record<string, string | boolean>>({ pages: '1', replace: false, m3u: '' });
  const [channel, setChannel] = useState({ provider: 'chatytv', param: '', title: '', logo: '', country: '', group: 'Canales TV', option: '' });
  const [channelMessage, setChannelMessage] = useState('');

  useEffect(() => {
    fetch('/sync/status').then(r => r.json()).then(setStatus).catch(() => {});
    fetch('/sync/auto-refresh').then(r => r.json()).then(setAuto).catch(() => {});
    const events = new EventSource('/sync/events');
    events.onmessage = e => { const event = JSON.parse(e.data); if (event.type === 'status') setStatus(event.status); if (event.type === 'log') setLogs(current => [...current.slice(-79), event.message]); };
    return () => events.close();
  }, []);

  const cards = useMemo(() => [...processDefs.map(d => d.key), 'refreshProvider'].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b))), [order]);
  const running = Object.values(status).filter(s => s.status === 'running').length;
  const completed = Object.values(status).filter(s => s.status === 'completed').length;
  const failed = Object.values(status).filter(s => s.status === 'failed').length;

  function toggleHidden(key: string) { const next = hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]; setHidden(next); localStorage.setItem('dashboard:hidden', JSON.stringify(next)); }
  function move(key: string, direction: -1 | 1) { const visible = cards.filter(k => !hidden.includes(k)); const i = visible.indexOf(key); const j = i + direction; if (i < 0 || j < 0 || j >= visible.length) return; [visible[i], visible[j]] = [visible[j], visible[i]]; setOrder(visible); localStorage.setItem('dashboard:order', JSON.stringify(visible)); }
  async function runProvider(provider: string) { await fetch('/live/channels/refresh-provider/' + encodeURIComponent(provider), { method: 'POST' }); }
  async function saveAuto(provider: string, value: string) { const next = { ...auto, providers: { ...auto.providers, [provider]: Number(value) || 0 } }; setAuto(next); await fetch('/sync/auto-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }); }
  async function execute(def: ProcessDef) {
    let url = def.route; const body: Record<string, unknown> = {};
    if (def.fields?.includes('pages')) { body.pages = Number(params.pages) || 1; body.replace = params.replace === true; }
    if (def.fields?.includes('m3u')) { body.content = params.m3u; if (!body.content) return; }
    const response = await fetch(url, { method: def.method, headers: { 'Content-Type': 'application/json' }, body: Object.keys(body).length ? JSON.stringify(body) : undefined });
    if (response.ok) setSelected(null); else alert((await response.json().catch(() => ({}))).error || 'No se pudo ejecutar');
  }
  async function addChannel() {
    if (!channel.param || (channel.provider !== 'chatytv' && !channel.title)) { setChannelMessage('Proveedor y título son obligatorios'); return; }
    const body: Record<string, string> = {}; for (const [key, value] of Object.entries(channel)) if (key !== 'provider' && key !== 'param' && value) body[key] = value;
    const response = await fetch('/live/channels/add/' + channel.provider + '/' + encodeURIComponent(channel.param), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})); setChannelMessage(response.ok ? 'Canal agregado correctamente' : (data.error || 'No se pudo agregar el canal'));
    if (response.ok) setChannel(current => ({ ...current, param: '', title: '', logo: '' }));
  }

  return <div className="shell"><aside><div className="brand"><span className="brand-mark">◆</span><span>Panel de Sincronización</span></div><nav><a className="active">▦ <span>Resumen</span></a><a href="/player">◉ <span>Canales</span></a><a href="/sync/detail/refreshProvider">▤ <span>Registros</span></a></nav><div className="system"><b>● Sistema</b><small>Conectado en tiempo real</small></div></aside>
    <main><header><div><span className="eyebrow">DASHBOARD</span><h1>Resumen operativo</h1><p>Estado de tus procesos actualizado al instante.</p></div><span className="live-pill">● Tiempo real</span></header>
      <section className="metrics"><Metric title="Procesos totales" value={processDefs.length + 1} tone="purple"/><Metric title="Ejecutándose" value={running} tone="green"/><Metric title="Completados" value={completed} tone="blue"/><Metric title="Con errores" value={failed} tone="red"/></section>
      <section className="content-grid"><div className="panel jobs"><div className="panel-head"><div><h2>Procesos</h2><span>Ejecuta cada tarjeta con sus parámetros</span></div><a href="/sync/status?code=1992">Vista clásica</a></div><div className="job-list">{cards.filter(k => !hidden.includes(k)).map(key => { const def = processDefs.find(d => d.key === key); const job = status[key] || { status: 'idle', lastRun: null }; return <article className="job" key={key}><button className="icon-button" title="Mover arriba" onClick={() => move(key, -1)}>↑</button><div className="job-main"><strong>{def?.label || 'Refresh por proveedor'}</strong><small>{job.progress?.message || job.error || 'Sin actividad reciente'}</small></div><StatusBadge status={job.status}/><small>{formatDate(job.lastRun)}</small>{def && <button className="action-button" onClick={() => { setSelected(def); setParams({ pages: '1', replace: false, m3u: '' }); }}>{def.fields ? '⚙ Parámetros' : '▶ Ejecutar'}</button>}<button className="icon-button" title="Ocultar" onClick={() => toggleHidden(key)}>⋯</button></article>; })}</div></div>
        <div className="side-column"><section className="panel"><div className="panel-head"><div><h2>Refresh por proveedor</h2><span>Intervalo y ejecución manual</span></div></div><label className="switch-row"><input type="checkbox" checked={auto.enabled} onChange={e => { const next = {...auto, enabled: e.target.checked}; setAuto(next); fetch('/sync/auto-refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(next) }); }}/><span>Activar programación</span></label><div className="provider-list">{providers.map(provider => <div className="provider" key={provider}><span className="dot"/><strong>{label(provider)}</strong><input type="number" min="1" value={auto.providers?.[provider] || ''} placeholder="min" onChange={e => saveAuto(provider, e.target.value)}/><small>{formatDate(auto.providerLastRuns?.[provider])}</small><button onClick={() => runProvider(provider)} disabled={status.refreshProvider?.status === 'running'}>▶</button></div>)}</div></section><section className="panel activity"><div className="panel-head"><div><h2>Actividad reciente</h2><span>Eventos recibidos por SSE</span></div></div><div className="logs">{logs.slice(-8).reverse().map((line, i) => <div key={i}>{line}</div>)}</div></section></div></section>
      <section className="panel add-card"><div className="panel-head"><div><h2>Agregar canales en vivo</h2><span>Consulta el proveedor y guarda el canal directamente</span></div></div><div className="form-grid"><Field label="Proveedor"><select value={channel.provider} onChange={e => setChannel({...channel, provider: e.target.value})}>{providers.map(p => <option key={p} value={p}>{label(p)}</option>)}</select></Field><Field label="Canal / Slug"><input value={channel.param} onChange={e => setChannel({...channel, param: e.target.value})} placeholder="ej: canal-sony-en-vivo-por-internet"/></Field><Field label="Título"><input value={channel.title} onChange={e => setChannel({...channel, title: e.target.value})} placeholder="Nombre del canal"/></Field><Field label="Logo URL"><input value={channel.logo} onChange={e => setChannel({...channel, logo: e.target.value})} placeholder="https://..."/></Field><Field label="País"><input value={channel.country} onChange={e => setChannel({...channel, country: e.target.value.toUpperCase()})} placeholder="CO"/></Field><Field label="Grupo"><input value={channel.group} onChange={e => setChannel({...channel, group: e.target.value})} placeholder="Canales TV"/></Field></div><div className="form-actions"><button className="primary-button" onClick={addChannel}>＋ Agregar canal</button>{channelMessage && <span className="form-message">{channelMessage}</span>}</div></section>
      {hidden.length > 0 && <div className="hidden-bar">Tarjetas ocultas: {hidden.map(key => <button key={key} onClick={() => toggleHidden(key)}>{key} +</button>)}</div>}
    </main>{selected && <Modal def={selected} params={params} setParams={setParams} close={() => setSelected(null)} execute={() => execute(selected)}/>}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Modal({ def, params, setParams, close, execute }: { def: ProcessDef; params: Record<string, string | boolean>; setParams: React.Dispatch<React.SetStateAction<Record<string, string | boolean>>>; close: () => void; execute: () => void }) { return <div className="modal-backdrop" onClick={close}><div className="modal-card" onClick={e => e.stopPropagation()}><button className="modal-close" onClick={close}>×</button><h2>{def.label}</h2><p>Configura los parámetros antes de ejecutar.</p>{def.fields?.includes('pages') && <><Field label="Páginas"><input type="number" min="1" value={String(params.pages || '')} onChange={e => setParams(p => ({...p, pages: e.target.value}))}/></Field><label className="switch-row"><input type="checkbox" checked={params.replace === true} onChange={e => setParams(p => ({...p, replace: e.target.checked}))}/><span>Reemplazar datos existentes</span></label></>}{def.fields?.includes('m3u') && <Field label="Contenido M3U"><textarea rows={8} value={String(params.m3u || '')} onChange={e => setParams(p => ({...p, m3u: e.target.value}))} placeholder="#EXTM3U..."/></Field>}<div className="form-actions"><button className="primary-button" onClick={execute}>▶ Ejecutar</button><button className="secondary-button" onClick={close}>Cancelar</button></div></div></div>; }
function Metric({ title, value, tone }: { title: string; value: number; tone: string }) { return <div className={'metric ' + tone}><span>{title}</span><b>{value}</b><small>Actualizado en vivo</small></div>; }
function StatusBadge({ status }: { status: string }) { return <span className={'badge ' + status}>{status === 'running' ? 'Ejecutando' : status === 'completed' ? 'Completado' : status === 'failed' ? 'Error' : 'En espera'}</span>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
