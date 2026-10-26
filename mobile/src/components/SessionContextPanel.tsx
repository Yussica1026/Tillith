import { useEffect, useRef, useState } from 'react';
import { safeError } from '../lib/api';
import { getSessionContext, listPersonaOptions, listWorldbooks, updateSessionContext, type PersonaOption, type SessionContext, type Worldbook } from '../lib/context-api';
import { ContextSources } from './ContextWorkspace';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import './chat-context.css';

export function SessionContextPanel({ sessionId, disabled, onChange, onManage, onNewPersonaSession }: { sessionId: string; disabled: boolean; onChange: (value: SessionContext) => void; onManage: () => void; onNewPersonaSession: (personaId: string) => Promise<void> }) {
  const [value, setValue] = useState<SessionContext>();
  const [draft, setDraft] = useState<SessionContext>();
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [books, setBooks] = useState<Worldbook[]>([]);
  const [editing, setEditing] = useState(false);
  const [sources, setSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    let active = true; alive.current = true;
    setBusy(true); setError('');
    void Promise.all([getSessionContext(sessionId), listPersonaOptions(), listWorldbooks()]).then(([context, people, worldbooks]) => {
      if (active) { setValue(context); setDraft(context); setPersonas(people); setBooks(worldbooks); onChange(context); }
    }).catch((reason) => { if (active) setError(safeError(reason)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; alive.current = false; };
  }, [sessionId, revision, onChange]);

  async function save(patch: Partial<SessionContext>, close = false) {
    if (disabled || busy) return;
    setBusy(true); setError('');
    try {
      const context = await updateSessionContext(sessionId, patch);
      if (alive.current) { setValue(context); setDraft(context); onChange(context); if (close) setEditing(false); }
    } catch (reason) { if (alive.current) setError(safeError(reason).includes('HTTP 409') ? '会话正在回复或已有其他人格的上下文。请等待回复结束；切换人格可使用下方的“新建该人格窗口”。' : safeError(reason)); }
    finally { if (alive.current) setBusy(false); }
  }

  const persona = personas.find((item) => item.id === value?.persona_id);
  return <section className="chat-context" aria-label="会话人格与世界书">
    <div className="chat-context-actions"><button type="button" className="text-button" disabled={disabled || busy || !value} onClick={() => { setDraft(value); setEditing(true); }}>{busy ? '正在读取上下文…' : persona?.name || (value?.persona_id ? '已选人格' : '人格与世界书')}</button><button type="button" className="text-button" disabled={disabled} onClick={() => setSources(true)}>查看注入来源</button>{error && !editing && <button type="button" className="text-button" disabled={busy} onClick={() => setRevision((old) => old + 1)}>重新读取</button>}</div>
    {error && !editing && <p className="field-help" role="alert">{error}</p>}
    {!!value?.worldbook_ids.length && <div className="context-worldbook-chips" aria-label="已选世界书">{value.worldbook_ids.map((id) => <span key={id}><span>{books.find((book) => book.id === id)?.name || '不可用的世界书'}</span><button type="button" disabled={disabled || busy} aria-label={`取消世界书 ${books.find((book) => book.id === id)?.name || id}`} onClick={() => void save({ worldbook_ids: value.worldbook_ids.filter((item) => item !== id) })}><Icon name="close" size={13} /></button></span>)}</div>}
    {editing && draft && <Dialog title="会话人格与世界书" onClose={() => { if (!busy) setEditing(false); }}>
      {error && <p className="message-error" role="alert">{error}</p>}
      <label className="dialog-field">会话人格<select value={draft.persona_id || ''} disabled={busy || disabled} onChange={(event) => setDraft({ ...draft, persona_id: event.target.value || null })}><option value="">跟随核心默认</option>{value?.persona_id && !personas.some((item) => item.id === value.persona_id) && <option value={value.persona_id}>原人格已不可用</option>}{personas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p className="field-help">已有消息的窗口保留原人格。不同人格请新建独立窗口，草稿会留在原会话。</p>
      {draft.persona_id && <button type="button" className="text-button" disabled={busy || disabled} onClick={() => { const id = draft.persona_id!; setEditing(false); void onNewPersonaSession(id); }}>新建该人格窗口</button>}
      <fieldset className="context-book-options"><legend>此会话使用的世界书</legend>{books.length ? books.map((book) => <label className="toggle-field" key={book.id}><input type="checkbox" checked={draft.worldbook_ids.includes(book.id)} disabled={busy || disabled || (!book.enabled && !draft.worldbook_ids.includes(book.id))} onChange={(event) => setDraft({ ...draft, worldbook_ids: event.target.checked ? [...draft.worldbook_ids, book.id] : draft.worldbook_ids.filter((id) => id !== book.id) })} /><span>{book.name}{!book.enabled && ' · 已停用'}</span></label>) : <p className="field-help">还没有世界书，可到工作区创建或导入。</p>}</fieldset>
      <label className="toggle-field"><input type="checkbox" checked={draft.memory_enabled} disabled={busy || disabled} onChange={(event) => setDraft({ ...draft, memory_enabled: event.target.checked })} /><span>召回当前人格的相关记忆</span></label>
      <label className="toggle-field"><input type="checkbox" checked={draft.memory_tools_enabled} disabled={busy || disabled} onChange={(event) => setDraft({ ...draft, memory_tools_enabled: event.target.checked })} /><span>允许模型检索、新增和修改当前人格记忆</span></label>
      <p className="field-help">记忆工具开关独立于关键词召回；仅影响这个会话。</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => { setEditing(false); onManage(); }}>打开工作区</button><button type="button" className="primary-button" disabled={busy || disabled} onClick={() => void save(draft, true)}>{busy ? '正在保存…' : '保存上下文设置'}</button></div>
    </Dialog>}
    {sources && <Dialog title="实际注入来源" onClose={() => setSources(false)}><ContextSources sessionId={sessionId} /></Dialog>}
  </section>;
}
