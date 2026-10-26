import { useEffect, useState } from 'react';
import { safeError, type Message } from '../lib/api';
import { createMemory, listPersonaOptions, type PersonaOption } from '../lib/context-api';
import { Dialog } from './Dialog';

export function RememberMessageDialog({ message, personaId, onClose, onSaved }: { message: Message; personaId?: string | null; onClose: () => void; onSaved: () => void }) {
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [person, setPerson] = useState(personaId || '');
  const [text, setText] = useState(message.text.slice(0, 8000));
  const [type, setType] = useState('note');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    void listPersonaOptions().then((people) => { if (active) { setPersonas(people); setPerson((id) => people.some((item) => item.id === id) ? id : ''); } }).catch((reason) => { if (active) setError(safeError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const sourceId = Number(message.id);
  return <Dialog title="将消息记为记忆" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault(); if (busy || loading || !person || !text.trim() || !Number.isSafeInteger(sourceId) || sourceId < 1) return;
      setBusy(true); setError('');
      void createMemory({ persona_id: person, type, text: text.trim(), starred: false, source_message_id: sourceId }).then(onSaved).catch((reason) => setError(safeError(reason))).finally(() => setBusy(false));
    }}>
      <p className="dialog-description">只保存下面的正文，不保存思考过程。记忆关联这条消息；来源被修改或删除后，会标记失效并停止召回。</p>
      {message.text.length > 8000 && <p className="field-help">原消息较长，请将已填入的前 8000 字整理为需要记住的内容。</p>}
      <label className="dialog-field">保存到人格<select aria-label="保存到人格" value={person} onChange={(event) => setPerson(event.target.value)} disabled={busy || loading} required><option value="">选择人格</option>{personas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="dialog-field">记忆类型<select aria-label="记忆类型" value={type} onChange={(event) => setType(event.target.value)} disabled={busy}><option value="note">笔记</option><option value="fact">事实</option><option value="preference">偏好</option><option value="event">事件</option><option value="promise">约定</option></select></label>
      <label className="dialog-field">记忆内容<textarea aria-label="记忆内容" rows={6} maxLength={8000} value={text} onChange={(event) => setText(event.target.value)} disabled={busy} required /></label>
      {error && <p className="message-error" role="alert">{error}</p>}
      {!loading && !personas.length && <p className="field-help">请先到“更多 → 人格、世界书与记忆”创建人格。</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => setRevision((old) => old + 1)}>刷新人格</button><button type="submit" className="primary-button" disabled={busy || loading || !person || !text.trim() || !Number.isSafeInteger(sourceId) || sourceId < 1}>{busy ? '正在保存…' : '保存记忆'}</button></div>
    </form>
  </Dialog>;
}
