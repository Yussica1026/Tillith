import { useEffect, useRef, useState, type FormEvent } from 'react';
import { listPersonaOptions, type PersonaOption } from '../lib/context-api';
import { createLifeEntry, deleteLifeEntry, listLifeEntries, updateLifeEntry, type LifeCategory, type LifeEntry, type LifeWrite } from '../lib/life-api';
import { deletePrivateDiary, listPrivateDiary, savePrivateDiary } from '../lib/private-diary';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import './context.css';
import './life.css';

const tabs = { board: '留言板', diary: '共同日记', life: '生活记录' } as const;
const categories: Record<LifeCategory, string> = { board: '留言', diary: '日记', expense: '记账', diet: '饮食', cycle: '生理期', daily: '日常', memo: '备忘', anniversary: '纪念日／倒数日' };
const lifeCategories = Object.entries(categories).filter(([id]) => id !== 'board' && id !== 'diary');
type Tab = keyof typeof tabs;
type DisplayEntry = LifeEntry & { local: boolean };
type Draft = LifeWrite & { original?: DisplayEntry; local: boolean };

function localDay() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

export function LifeWorkspace({ onBack, storageId }: { onBack: () => void; storageId: string }) {
  const [options, setOptions] = useState<PersonaOption[]>();
  const [personaId, setPersonaId] = useState('');
  const [tab, setTab] = useState<Tab>('board');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    setError(false); setOptions(undefined); setPersonaId('');
    void listPersonaOptions().then(items => {
      if (current) { setOptions(items); setPersonaId(items[0]?.id || ''); }
    }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [storageId, revision]);
  const persona = options?.find(item => item.id === personaId);
  return <main className="settings-page context-workspace life-workspace">
    <div className="page-heading"><div>
      <button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button>
      <h1>生活簿</h1>
    </div></div>
    {error && <div className="context-notice" role="alert">人格列表读取失败，请检查连接。
      <button type="button" className="text-button" onClick={() => setRevision(count => count + 1)}>重试</button></div>}
    {!options && !error && <p className="field-help" role="status">正在读取人格…</p>}
    {options?.length === 0 && <p className="context-empty">先在「人格、世界书与记忆」中新建人格，再打开生活簿。</p>}
    {!!options?.length && <label className="dialog-field">所属人格<select value={personaId} onChange={event => setPersonaId(event.target.value)}>
      {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    <nav className="context-tabs" aria-label="生活簿分类">
      {(Object.keys(tabs) as Tab[]).map(item => <button type="button" key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{tabs[item]}</button>)}
    </nav>
    {persona && <LifeEntries key={JSON.stringify([storageId, persona.id, tab])} scope={JSON.stringify([storageId, persona.id])} persona={persona} tab={tab} />}
  </main>;
}

function LifeEntries({ scope, persona, tab }: { scope: string; persona: PersonaOption; tab: Tab }) {
  const [remote, setRemote] = useState<LifeEntry[]>(), [local, setLocal] = useState<LifeEntry[]>();
  const [remoteError, setRemoteError] = useState(false), [localError, setLocalError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Draft>(), [deleting, setDeleting] = useState<DisplayEntry>();
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [filter, setFilter] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    let current = true;
    mounted.current = true;
    setRemoteError(false); setRemote(undefined);
    void listLifeEntries(persona.id).then(items => { if (current) setRemote(items); }).catch(() => { if (current) setRemoteError(true); });
    if (tab === 'diary') {
      setLocalError(false); setLocal(undefined);
      void listPrivateDiary(scope).then(items => { if (current) setLocal(items); }).catch(() => { if (current) setLocalError(true); });
    }
    return () => { current = false; mounted.current = false; };
  }, [persona.id, tab, scope, revision]);

  const entries: DisplayEntry[] = [
    ...(remote || []).filter(item => tab === 'life' ? item.category !== 'diary' && item.category !== 'board' : item.category === tab).map(item => ({ ...item, local: false })),
    ...(local || []).map(item => ({ ...item, local: true })),
  ].sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at));
  const parents = new Map(entries.filter(item => !item.parent_id).map(item => [item.id, item]));
  const replies = new Map<string, DisplayEntry[]>();
  for (const item of entries) {
    if (!item.parent_id) continue;
    const thread = replies.get(item.parent_id) || [];
    thread.push(item); replies.set(item.parent_id, thread);
  }
  const visible = entries.filter(item => (!item.parent_id || !parents.has(item.parent_id)) && (!filter || (tab === 'diary' ? item.author === filter : item.category === filter)));
  const loading = (!remote && !remoteError) || (tab === 'diary' && !local && !localError);
  const action = tab === 'diary' ? '写日记' : tab === 'board' ? '写留言' : '记一笔';

  function compose(original?: DisplayEntry, parent?: DisplayEntry) {
    const category = original?.category || (tab === 'life' ? (filter as LifeCategory || 'daily') : tab);
    setFormError('');
    setDraft({ original, category, day: original?.day || localDay(), text: original?.text || '',
      ai_visible: original?.ai_visible || false, parent_id: original?.parent_id || parent?.id || null, local: original?.local ?? tab === 'diary' });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const text = draft.text.trim();
    if (!text) { setFormError('请填写正文。'); return; }
    setBusy(true); setFormError('');
    try {
      let saved: LifeEntry;
      if (draft.local) {
        saved = await savePrivateDiary(scope, draft.day, text, draft.original);
      } else if (draft.original) {
        const update = draft.original.author === 'ai' ? { ai_visible: draft.ai_visible } : { text, day: draft.day, ai_visible: draft.ai_visible };
        saved = await updateLifeEntry(persona.id, draft.original.id, update);
      } else {
        saved = await createLifeEntry(persona.id, { category: draft.category, text, ai_visible: draft.ai_visible, day: draft.day, parent_id: draft.parent_id });
      }
      if (!mounted.current) return;
      const updateList = draft.local ? setLocal : setRemote;
      updateList(current => [saved, ...(current || []).filter(item => item.id !== saved.id)]);
      if (filter && ((tab === 'diary' && saved.author !== filter) || (tab === 'life' && saved.category !== filter))) setFilter('');
      setDraft(undefined);
    } catch {
      if (mounted.current) setFormError(draft.local ? '本机保存失败，请检查设备存储空间后重试。' : '保存失败。请检查连接、人格权限和原记录后重试。');
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove() {
    if (!deleting || busy) return;
    setBusy(true); setFormError('');
    try {
      if (deleting.local) await deletePrivateDiary(scope, deleting.id);
      else await deleteLifeEntry(persona.id, deleting.id);
      if (!mounted.current) return;
      const updateList = deleting.local ? setLocal : setRemote;
      updateList(current => current?.filter(item => item.id !== deleting.id && item.parent_id !== deleting.id));
      setDeleting(undefined);
    } catch { if (mounted.current) setFormError('删除失败，请检查存储或连接后重试。'); }
    finally { if (mounted.current) setBusy(false); }
  }

  function entryContent(item: DisplayEntry) {
    const parent = item.parent_id ? parents.get(item.parent_id) : undefined;
    const readable = item.ai_visible && (!item.parent_id || parent?.ai_visible);
    const days = item.category === 'anniversary' ? Math.round((Date.parse(item.day) - Date.parse(localDay())) / 86400000) : undefined;
    return <>
      <header className="life-entry-heading"><strong>{item.author === 'ai' ? persona.name + '写的' : '我写的'}</strong>
        <time dateTime={item.created_at}>{item.category === 'board' ? new Date(item.created_at).toLocaleString() : item.day}</time>
      </header>
      {tab === 'life' && <p className="life-entry-type">{categories[item.category]}{days !== undefined && (days === 0 ? ' · 就在今天' : days > 0 ? ' · 还有 ' + days + ' 天' : ' · 已过 ' + Math.abs(days) + ' 天')}</p>}
      <p className="context-memory-text">{item.text}</p>
      <small>{item.local ? '仅在本机' : readable ? '已允许人格参考' : '人格不可见'}</small>
      <div className="context-actions">
        {tab === 'board' && !item.parent_id && <button className="text-button" type="button" disabled={busy} onClick={() => compose(undefined, item)}>回复留言</button>}
        {(item.author === 'user' || item.category !== 'diary') && <button className="text-button" type="button" disabled={busy} onClick={() => compose(item)}>{item.author === 'ai' ? '设置可见范围' : '编辑'}</button>}
        <button className="text-button danger-text" type="button" disabled={busy} onClick={() => { setFormError(''); setDeleting(item); }}>删除</button>
      </div>
    </>;
  }

  return <section aria-label={tabs[tab]}>
    <details className="life-access"><summary>人格怎样读写生活簿？</summary><p>在「更多 → 人格、世界书与记忆 → 编辑人格 → 工具与 MCP」勾选 <code>tillith_life_read</code> 允许读取、<code>tillith_life_write</code> 允许写入。读取还需要每条记录单独授权，本机日记仅供自己阅读。</p></details>
    <div className="context-toolbar"><button type="button" className="primary-button" disabled={busy || (tab === 'diary' ? !remote && !local : !remote)} onClick={() => compose()}><Icon name="plus" size={17} />{action}</button>
      <button type="button" className="text-button" disabled={loading || busy} onClick={() => setRevision(count => count + 1)}>刷新</button></div>
    {tab !== 'board' && <label className="dialog-field">{tab === 'diary' ? '作者' : '记录类型'}<select value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="">全部</option>{tab === 'diary' ? <><option value="user">我写的</option><option value="ai">AI 写的</option></> :
        lifeCategories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>}
    {loading && <p className="field-help" role="status">正在读取…</p>}
    {remoteError && <p className="context-notice" role="alert">服务器记录读取失败，请检查连接后刷新。</p>}
    {localError && <p className="context-notice" role="alert">本机日记读取失败，请检查设备存储权限后刷新。</p>}
    {!loading && !remoteError && !localError && !visible.length && <p className="context-empty">{filter ? '这个分类下还没有记录。' : '这里还没有' + (tab === 'life' ? '生活记录' : categories[tab]) + '。'}</p>}
    <div className="context-cards">{visible.map(item => <article className="context-card life-entry" key={(item.local ? 'local:' : 'core:') + item.id}>
      {entryContent(item)}
      {[...(replies.get(item.id) || [])].reverse().map(reply => <article key={reply.id} className="life-reply" aria-label="留言回复">{entryContent(reply)}</article>)}
    </article>)}</div>
    {draft && <Dialog title={draft.original ? '编辑' + categories[draft.category] : draft.parent_id ? '回复留言' : action} onClose={() => { if (!busy) setDraft(undefined); }}>
      <form className="context-form" autoComplete="off" onSubmit={event => void save(event)}>
        {formError && <p className="message-error" role="alert">{formError}</p>}
        <fieldset className="life-fields" disabled={busy}>
        {tab === 'life' && !draft.original && <label className="dialog-field">记录类型<select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value as LifeCategory })}>
          {lifeCategories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>}
        {tab !== 'board' && <label className="dialog-field">日期<input type="date" required max="9999-12-31" disabled={draft.original?.author === 'ai'} value={draft.day} onChange={event => setDraft({ ...draft, day: event.target.value })} /></label>}
        <label className="dialog-field">正文<textarea required spellCheck={false} maxLength={8000} rows={6} readOnly={draft.original?.author === 'ai'} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
        {tab === 'diary' ? <>
          {draft.original ? <p className="field-help">{draft.local ? '这篇日记仅保存在本机。' : '这篇共同日记已分享给' + persona.name + '，保存在当前服务器。'}</p> :
            <label className="toggle-field"><input type="checkbox" checked={!draft.local} onChange={event => setDraft({ ...draft, local: !event.target.checked, ai_visible: event.target.checked })} />
              分享给{persona.name}，保存到当前服务器</label>}
          {!draft.original && draft.local && <p className="field-help">仅在这台设备上加密保存。</p>}
        </> : <label className="toggle-field"><input type="checkbox" checked={draft.ai_visible} onChange={event => setDraft({ ...draft, ai_visible: event.target.checked })} />允许{persona.name}在对话中参考</label>}
        {draft.parent_id && !parents.get(draft.parent_id)?.ai_visible && <p className="field-help">原留言目前对人格隐藏；回复需同时获得原留言和本条回复的授权。</p>}
        </fieldset>
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || (draft.local ? !local : !remote)}>{busy ? '正在保存…' : '保存'}</button></div>
      </form>
    </Dialog>}
    {deleting && <Dialog title="删除这条记录？" onClose={() => { if (!busy) setDeleting(undefined); }}>
      <p className="dialog-description">{deleting.category === 'board' && !deleting.parent_id ? '原留言和它的所有回复将一并删除。' : '删除后无法恢复。'}</p>
      {formError && <p className="message-error" role="alert">{formError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button>
        <button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>确认删除</button></div>
    </Dialog>}
  </section>;
}
