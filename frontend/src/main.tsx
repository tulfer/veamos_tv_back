import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Job = { status: string; lastRun: number | null; duration?: number; count?: number; error?: string; progress?: { current: number; total?: number; message: string } };
type Status = Record<string, Job>;
type AutoRefresh = { enabled: boolean; providers: Record<string, number>; providerLastRuns: Record<string, number> };
const providers = ['wsdeportes', 'cablevisionhd', 'tvporinternet2', 'tvenvivo2', 'chatytv', 'senalcolombia', 'vertvcable'];

function formatDate(value?: number | null) { return value ? new Date(value).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Sin ejecutar'; }
function label(value: string) { return value === 'tvenvivo2' ? 'TVEnVivo2' : value; }

function App() {
  const [status, setStatus] = useState<Status>({});
  const [auto, setAuto] = useState<AutoRefresh>({ enabled: true, providers: {}, providerLastRuns: {} });
  const [logs, setLogs] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => JSON.parse(localStorage.getItem('dashboard:hidden') || '[]'));
  const [order, setOrder] = useState<string[]>(() => JSON.parse(localStorage.getItem('dashboard:order') || '[]'));

  useEffect(() => {
    fetch('/sync/status').then(r => r.json()).then(setStatus).catch(() => {});
    fetch('/sync/auto-refresh').then(r => r.json()).then(setAuto).catch(() => {});
    const events = new EventSource('/sync/events');
    events.onmessage = e => { const event = JSON.parse(e.data); if (event.type === 'status') setStatus(event.status); if (event.type === 'log') setLogs(current => [...current.slice(-79), event.message]); };
    return () => events.close();
  }, []);

  const cards = useMemo(() => {
    const keys = Object.keys(status).filter(k => !['refreshOne', 'migrate'].includes(k));
    return [...keys].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  }, [status, order]);
  const running = Object.values(status).filter(s => s.status === 'running').length;
  const completed = Object.values(status).filter(s => s.status === 'completed').length;
  const failed = Object.values(status).filter(s => s.status === 'failed').length;

  function toggleHidden(key: string) { const next = hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]; setHidden(next); localStorage.setItem('dashboard:hidden', JSON.stringify(next)); }
  function move(key: string, direction: -1 | 1) { const visible = cards.filter(k => !hidden.includes(k)); const i = visible.indexOf(key); const j = i + direction; if (i < 0 || j < 0 || j >= visible.length) return; [visible[i], visible[j]] = [visible[j], visible[i]]; setOrder(visible); localStorage.setItem('dashboard:order', JSON.stringify(visible)); }
  async function run(provider: string) { await fetch('/live/channels/refresh-provider/' + encodeURIComponent(provider), { method: 'POST' }); }
  async function saveAuto(provider: string, value: string) { const providersNext = { ...auto.providers, [provider]: Number(value) || 0 }; const next = { ...auto, providers: providersNext }; setAuto(next); await fetch('/sync/auto-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }); }

  return <div className="shell">
    <aside><div className="brand"><span className="brand-mark">◆</span><span>Panel de Sincronización</span></div><nav><a className="active">▦ <span>Resumen</span></a><a href="/player">◉ <span>Canales</span></a><a href="/sync/detail/refreshProvider">▤ <span>Registros</span></a></nav><div className="system"><b>● Sistema</b><small>Conectado en tiempo real</small></div></aside>
    <main><header><div><span className="eyebrow">DASHBOARD</span><h1>Resumen operativo</h1><p>Estado de tus procesos actualizado al instante.</p></div><span className="live-pill">● Tiempo real</span></header>
      <section className="metrics"><Metric title="Procesos totales" value={Object.keys(status).length} tone="purple"/><Metric title="Ejecutándose" value={running} tone="green"/><Metric title="Completados" value={completed} tone="blue"/><Metric title="Con errores" value={failed} tone="red"/></section>
      <section className="content-grid"><div className="panel jobs"><div className="panel-head"><div><h2>Procesos</h2><span>Actividad del sistema</span></div><a href="/sync/status?code=1992">Vista clásica</a></div><div className="job-list">{cards.filter(k => !hidden.includes(k)).map((key, i) => <article className="job" key={key}><button className="icon-button" title="Mover arriba" onClick={() => move(key, -1)}>↑</button><div className="job-main"><strong>{key}</strong><small>{status[key]?.progress?.message || 'Sin actividad reciente'}</small></div><StatusBadge status={status[key]?.status || 'idle'}/><small>{formatDate(status[key]?.lastRun)}</small><button className="icon-button" title="Ocultar" onClick={() => toggleHidden(key)}>⋯</button></article>)}</div></div>
        <div className="side-column"><section className="panel"><div className="panel-head"><div><h2>Refresh por proveedor</h2><span>Intervalo y ejecución manual</span></div></div><label className="switch-row"><input type="checkbox" checked={auto.enabled} onChange={e => { const next = {...auto, enabled: e.target.checked}; setAuto(next); fetch('/sync/auto-refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(next) }); }}/><span>Activar programación</span></label><div className="provider-list">{providers.map(provider => <div className="provider" key={provider}><span className="dot"/><strong>{label(provider)}</strong><input type="number" min="1" value={auto.providers?.[provider] || ''} placeholder="min" onChange={e => saveAuto(provider, e.target.value)}/><small>{formatDate(auto.providerLastRuns?.[provider])}</small><button onClick={() => run(provider)} disabled={status.refreshProvider?.status === 'running'}>▶</button></div>)}</div></section><section className="panel activity"><div className="panel-head"><div><h2>Actividad reciente</h2><span>Eventos recibidos por SSE</span></div></div><div className="logs">{logs.slice(-8).reverse().map((line, i) => <div key={i}>{line}</div>)}</div></section></div></section>
      {hidden.length > 0 && <div className="hidden-bar">Tarjetas ocultas: {hidden.map(key => <button key={key} onClick={() => toggleHidden(key)}>{key} +</button>)}</div>}
    </main></div>;
}

function Metric({ title, value, tone }: { title: string; value: number; tone: string }) { return <div className={'metric ' + tone}><span>{title}</span><b>{value}</b><small>Actualizado en vivo</small></div>; }
function StatusBadge({ status }: { status: string }) { return <span className={'badge ' + status}>{status === 'running' ? 'Ejecutando' : status === 'completed' ? 'Completado' : status === 'failed' ? 'Error' : 'En espera'}</span>; }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
