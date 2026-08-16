import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type DeviceCode = { code: string; note: string; enabled: boolean; deviceId: string | null; createdAt: number; boundAt: number | null; lastSeenAt: number | null };

function Head({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="panel-head"><div><h2>{title}</h2><span>{subtitle}</span></div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

const fmt = (ts: number | null) => ts ? new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

function App() {
  const [codes, setCodes] = useState<DeviceCode[]>([]);
  const [note, setNote] = useState('');
  const [custom, setCustom] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetch('/devices/codes').then(r => r.json()).then(d => setCodes(d.items || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const gen = () => setCustom(String(Math.floor(100000 + Math.random() * 900000)));

  const create = async () => {
    if (custom.trim() && !/^\d{6}$/.test(custom.trim())) return setMsg('✖ El código debe tener 6 dígitos');
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/devices/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: note.trim(), code: custom.trim() || undefined }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Error HTTP ' + r.status);
      setMsg('✔ Código ' + d.code.code + ' registrado' + (d.code.note ? ' (' + d.code.note + ')' : ''));
      setNote(''); setCustom('');
      load();
    } catch (e: any) { setMsg('✖ ' + (e.message || 'Error')); } finally { setBusy(false); }
  };

  const unlink = async (code: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/devices/codes/' + code + '/unlink', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Error HTTP ' + r.status);
      setMsg('✔ Código ' + code + ' liberado (listo para otro dispositivo)');
      load();
    } catch (e: any) { setMsg('✖ ' + (e.message || 'Error')); } finally { setBusy(false); }
  };

  const remove = async (code: string) => {
    if (!window.confirm('¿Eliminar el código ' + code + '? Se perderá su vínculo con el dispositivo.')) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/devices/codes/' + code, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Error HTTP ' + r.status);
      setMsg('✔ Código ' + code + ' eliminado');
      load();
    } catch (e: any) { setMsg('✖ ' + (e.message || 'Error')); } finally { setBusy(false); }
  };

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setMsg('✔ Código ' + code + ' copiado'); } catch { setMsg('✖ No se pudo copiar'); }
  };

  const inUse = codes.filter(c => c.deviceId).length;
  const free = codes.length - inUse;

  return <main style={{ maxWidth: 1100, margin: 'auto', padding: 32 }}>
    <header>
      <div>
        <div className="eyebrow">VEAMOS TV</div>
        <h1>Panel de Códigos</h1>
        <p>Registra códigos de 6 dígitos; cada uno se vincula al primer dispositivo que lo registre.</p>
      </div>
      <span className="live-pill">● Activo</span>
    </header>
    <div className="metrics">
      <div className="metric purple"><span>Códigos totales</span><b>{codes.length}</b></div>
      <div className="metric green"><span>En uso</span><b>{inUse}</b></div>
      <div className="metric blue"><span>Libres</span><b>{free}</b></div>
      <div className="metric"><span>URL de ejemplo</span><small style={{ fontFamily: 'ui-monospace,Consolas,monospace' }}>/v2/123456/home</small></div>
    </div>
    <section className="panel">
      <Head title="Registrar código" subtitle="Genera uno al azar o escribe uno propio; agrega una nota para identificarlo." />
      <div className="gitem-row">
        <Field label="Nota (opcional)"><input value={note} onChange={e => setNote(e.target.value)} placeholder="ej: TV sala, Android TV de maria..." /></Field>
        <Field label="Código (opcional)"><input value={custom} onChange={e => setCustom(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 dígitos" /></Field>
        <button className="ghost-button" onClick={gen} disabled={busy}>🎲 Generar</button>
        <button className="primary-button" onClick={create} disabled={busy}>{busy ? '⟳ Trabajando...' : '➕ Registrar código'}</button>
      </div>
      {msg && <div className="form-message">{msg}</div>}
    </section>
    <section className="panel" style={{ marginTop: 18 }}>
      <Head title="Códigos registrados" subtitle="El primer dispositivo que registre un código queda vinculado a él para siempre." />
      <table className="codes-table">
        <thead>
          <tr><th>Código</th><th>Nota</th><th>Estado</th><th>Última conexión</th><th>Creado</th><th>Acciones</th></tr>
        </thead>
        <tbody>
          {codes.map(c => (
            <tr key={c.code}>
              <td><span className="code-chip">{c.code}</span><button className="copy-btn" onClick={() => copy(c.code)}>copiar</button></td>
              <td>{c.note || '—'}</td>
              <td>{c.deviceId ? <><span className="badge-enuso">En uso</span><div className="dev-short">{c.deviceId.length > 24 ? c.deviceId.slice(0, 24) + '…' : c.deviceId}</div></> : <span className="badge-libre">Libre</span>}</td>
              <td>{fmt(c.lastSeenAt)}</td>
              <td>{fmt(c.createdAt)}</td>
              <td><div className="code-actions">{c.deviceId && <button className="mini-btn" onClick={() => unlink(c.code)} disabled={busy} title="Desvincula el dispositivo actual; el código queda libre">Liberar</button>}<button className="mini-btn danger" onClick={() => remove(c.code)} disabled={busy}>Eliminar</button></div></td>
            </tr>
          ))}
          {!codes.length && <tr><td colSpan={6} style={{ color: '#8d95b7', textAlign: 'center', padding: 20 }}>Todavía no hay códigos. Registra el primero arriba.</td></tr>}
        </tbody>
      </table>
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);