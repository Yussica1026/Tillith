import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/context-api';
import { safeError } from '../lib/api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function MemoryPanel() {
  const [personas, setPersonas] = useState<api.PersonaOption[]>([]);
  const [persona, setPersona] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [view, setView] = useState('all');
  const [memories, setMemories] = useState<api.Memory[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<{ id?: string; persona_id: string; type: string; text: string; starred: boolean }>();
  const [formError, setFormError] = useState('');
  const [deleting, setDeleting] = useState<api.Memory>();
  const requestVersion = useRef(0);
  async function refresh() {
    const version = ++requestVersion.current;
    const [items, options] = await Promise.all([api.listMemories(persona || undefined, search, view === 'trash'), api.listPersonaOptions()]);
    if (version === requestVersion.current) { setMemories(items); setPersonas(options); }
  }
  async function operation(task: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await task(); await refresh(); setNotice(message); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { setMemories(undefined); void operation(async () => {}, ''); return () => { requestVersion.current++; }; }, [persona, search, view]);
  const visible = memories?.filter(item => (!type || item.type === type) && (view !== 'starred' || item.starred) && (view !== 'invalid' || item.invalidated));
  function edit(memory?: api.Memory) {
    setFormError(''); setDraft({ id: memory?.id, persona_id: memory?.persona_id || persona || personas[0]?.id || '', type: memory?.type || 'note', text: memory?.text || '', starred: memory?.starred || false });
  }
  return <section aria-label="记忆管理"><p className="context-intro">留下想被记住的事。记忆按人格分别保存，只有会话允许时才会被检索和引用。</p><div className="context-toolbar"><button type="button" className="primary-button" disabled={busy || !personas.length} onClick={() => edit()}><Icon name="plus" size={17} />记一条</button><button type="button" className="text-button" disabled={busy} onClick={() => void operation(async () => {}, '')}>刷新</button></div><form className="context-search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}><label className="dialog-field">搜索记忆<input type="search" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入记忆中的关键词" /></label><button type="submit" className="secondary-button" disabled={busy}>搜索</button></form><div className="context-filters"><label className="dialog-field">所属人格<select disabled={busy} value={persona} onChange={event => { setPersona(event.target.value); setType(''); }}><option value="">所有人格</option>{personas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="dialog-field">记忆类型<select disabled={busy} value={type} onChange={event => setType(event.target.value)}><option value="">所有类型</option>{[...new Set(memories?.map(item => item.type) || [])].map(value => <option key={value} value={value}>{value === 'note' ? '笔记' : value}</option>)}</select></label></div><nav className="context-filter-tabs" aria-label="记忆状态">{[['all', '全部'], ['starred', '星标'], ['invalid', '来源失效'], ['trash', '回收站']].map(([id, label]) => <button type="button" key={id} disabled={busy} aria-pressed={view === id} onClick={() => { setView(id); setType(''); }}>{label}</button>)}</nav>{error && <p className="context-notice" role="alert">{error}</p>}{notice && <p className="context-notice" role="status">{notice}</p>}{busy && !memories && <p className="field-help" role="status">正在读取记忆…</p>}
    <div className="context-cards">{visible?.map(memory => <article className={'context-card memory-card' + (memory.invalidated ? ' memory-card--invalid' : '')} key={memory.id}><div className="context-card-heading"><div><h2>{personas.find(item => item.id === memory.persona_id)?.name || memory.persona_id}</h2><span>{memory.type === 'note' ? '笔记' : memory.type} · {new Date(memory.updated_at).toLocaleDateString()}</span></div><button type="button" className="context-star" aria-label={memory.starred ? '取消记忆星标' : '星标记忆'} aria-pressed={memory.starred} disabled={busy || memory.trashed} onClick={() => void operation(() => api.updateMemory(memory.id, { starred: !memory.starred }), memory.starred ? '已取消星标。' : '记忆已星标。')}>{memory.starred ? '★' : '☆'}</button></div><p className="context-memory-text">{memory.text}</p>{memory.source_message_id && <p className="field-help">来自消息 #{memory.source_message_id}</p>}{memory.invalidated && <p className="context-memory-invalid">来源消息已修改或删除，这条记忆不会参与召回。</p>}<div className="context-actions">{memory.trashed ? <button type="button" className="text-button" disabled={busy} onClick={() => void operation(() => api.updateMemory(memory.id, { trashed: false }), '记忆已恢复。')}>恢复记忆</button> : <><button type="button" className="text-button" disabled={busy} onClick={() => edit(memory)}>编辑记忆</button><button type="button" className="text-button danger-text" disabled={busy} onClick={() => setDeleting(memory)}>移入回收站</button></>}</div></article>)}</div>{visible?.length === 0 && <p className="context-empty">{view === 'trash' ? '回收站里没有记忆。' : search || persona || type || view !== 'all' ? '没有符合条件的记忆。' : '还没有记忆。可以先写一条希望这个人格记住的事。'}</p>}
    {draft && <Dialog title={draft.id ? '编辑记忆' : '记一条'} onClose={() => { if (!busy) setDraft(undefined); }}><form className="context-form" onSubmit={async event => { event.preventDefault(); if (!draft.text.trim() || !draft.type.trim() || !draft.persona_id) { setFormError('请选择人格并填写类型与正文。'); return; } setBusy(true); setFormError(''); try { if (draft.id) await api.updateMemory(draft.id, { type: draft.type.trim(), text: draft.text, starred: draft.starred }); else await api.createMemory({ persona_id: draft.persona_id, type: draft.type.trim(), text: draft.text, starred: draft.starred }); await refresh(); setDraft(undefined); setNotice('记忆已保存。'); } catch (reason) { setFormError(safeError(reason)); } finally { setBusy(false); } }}>{formError && <p className="message-error" role="alert">{formError}</p>}<label className="dialog-field">所属人格<select required disabled={!!draft.id} value={draft.persona_id} onChange={event => setDraft({ ...draft, persona_id: event.target.value })}><option value="">选择人格</option>{personas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="dialog-field">记忆类型<input aria-label="记忆类型" required maxLength={50} value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value })} list="context-memory-types" /><datalist id="context-memory-types"><option value="note">笔记</option><option value="preference">偏好</option><option value="fact">事实</option></datalist></label><label className="dialog-field">记忆正文<textarea aria-label="记忆正文" required maxLength={8000} rows={8} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label><label className="toggle-field"><input type="checkbox" checked={draft.starred} onChange={event => setDraft({ ...draft, starred: event.target.checked })} />加上星标</label><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存记忆'}</button></div></form></Dialog>}
    {deleting && <Dialog title="移入回收站？" onClose={() => setDeleting(undefined)}><p className="dialog-description">这条记忆将停止参与召回，之后可以在回收站恢复。</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" onClick={() => { const id = deleting.id; setDeleting(undefined); void operation(() => api.trashMemory(id), '记忆已移入回收站。'); }}>移入回收站</button></div></Dialog>}
  </section>;
}
