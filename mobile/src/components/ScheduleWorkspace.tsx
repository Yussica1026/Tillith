import { useEffect, useRef, useState, type FormEvent } from 'react';
import { chatRequest, safeError, type Session } from '../lib/api';

type Delivery = 'message' | 'wake';
type Schedule = { id: string; session_id: string; note: string; kind: Delivery; at: string | null; daily: string | null; timezone: string };

export function ScheduleWorkspace({ sessions, onBack }: { sessions: Session[]; onBack: () => void }) {
  const [items, setItems] = useState<Schedule[]>([]);
  const [sessionId, setSessionId] = useState(sessions[0]?.id || '');
  const [kind, setKind] = useState<Delivery>('message');
  const [daily, setDaily] = useState(false);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    chatRequest('/tillith/schedules').then(data => {
      if (active) setItems(data.items);
    }).catch(reason => { if (active) setError(safeError(reason)); });
    return () => { active = false; };
  }, [revision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!sessionId || busy || !when || !note.trim()) return;
    setBusy(true); setError('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await chatRequest('/tillith/schedules', { method: 'POST', body: JSON.stringify({
        session_id: sessionId, kind, note: note.trim(), timezone,
        ...(daily ? { daily: when } : { at: new Date(when).toISOString() }),
      }) });
      if (mounted.current) { setNote(''); setRevision(value => value + 1); }
    } catch (reason) { if (mounted.current) setError(safeError(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function cancel(id: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await chatRequest('/tillith/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
      if (mounted.current) setRevision(value => value + 1);
    } catch (reason) { if (mounted.current) setError(safeError(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <main className="settings-page">
    <header className="page-heading"><div><button className="text-button" onClick={onBack}>返回更多</button><h1>定时留言</h1></div></header>
    {error && <p className="message-error" role="alert">{error} <button className="text-button" onClick={() => {setError(''); setRevision(v => v + 1);}}>重新读取</button></p>}
    <form className="settings-section context-form" onSubmit={submit}>
      <label className="dialog-field">接收会话<select required value={sessionId} onChange={e => setSessionId(e.target.value)}>{!sessionId && <option value="">选择会话</option>}{sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <label className="dialog-field">留言方式<select value={kind} onChange={e => setKind(e.target.value as Delivery)}><option value="message">发送我写的原文</option><option value="wake">让会话的模型写一条留言</option></select></label>
      <label className="dialog-field">{kind === 'wake' ? '定时发给模型的要求' : '留言内容'}<textarea required maxLength={2000} rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>
      <label className="dialog-field">重复<select value={daily ? 'daily' : 'once'} onChange={e => {setDaily(e.target.value === 'daily'); setWhen('');}}><option value="once">仅一次</option><option value="daily">每天</option></select></label>
      <label className="dialog-field">发送时间<input key={String(daily)} type={daily ? 'time' : 'datetime-local'} required value={when} onChange={e => setWhen(e.target.value)} /></label>
      <button className="primary-button" disabled={busy || !sessionId}>保存定时留言</button>
    </form>
    <section className="settings-section"><h2>已安排</h2>{items.map(item => <article key={item.id}>
      <strong>{item.daily ? '每天 ' + item.daily + ' · ' + item.timezone : new Date(item.at!).toLocaleString()}</strong>
      <p>{sessions.find(s => s.id === item.session_id)?.title || '原会话'} · {item.kind === 'wake' ? '模型留言' : '原文留言'}</p><p>{item.note}</p>
      <button className="text-button" disabled={busy} onClick={() => void cancel(item.id)}>取消此安排</button>
    </article>)}{!items.length && <p>还没有定时留言。</p>}</section>
  </main>;
}
