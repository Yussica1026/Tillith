import { useEffect, useState, type FormEvent } from 'react';
import * as api from '../lib/context-api';
import { listChatOptions, safeError, type ChatOptions } from '../lib/api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { QuickPhrases } from './QuickPhrases';

type Draft = { id?: string; name: string; prompt: string; dialogs: api.Persona['begin_dialogs']; folder: string; config: string; provider: string };
export function PersonaPanel({ storageId, onSettings, onOpenPersona }: { storageId: string; onSettings: () => void; onOpenPersona?: (personaId: string, newSession: boolean) => Promise<void> }) {
  const [personas, setPersonas] = useState<api.Persona[]>();
  const [options, setOptions] = useState<api.PersonaOption[]>([]);
  const [folders, setFolders] = useState<api.PersonaFolder[]>([]);
  const [folder, setFolder] = useState('*');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [formError, setFormError] = useState('');
  const [folderDraft, setFolderDraft] = useState<{ id?: string; name: string; parent: string }>();
  const [deleting, setDeleting] = useState<{ id: string; name: string; kind: 'persona' | 'folder' }>();
  const [phrases, setPhrases] = useState<string>();
  const [chatOptions, setChatOptions] = useState<ChatOptions>();
  const [optionsBusy, setOptionsBusy] = useState(false);
  async function refresh() {
    const [items, names, tree] = await Promise.all([api.listPersonas(), api.listPersonaOptions(), api.listPersonaFolders()]);
    const flat = tree.flatMap(function visit(item): api.PersonaFolder[] { return [item, ...(item.children || []).flatMap(visit)]; });
    setPersonas(items.sort((a, b) => a.sort_order - b.sort_order)); setOptions(names); setFolders(flat);
  }
  async function operation(task: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await task(); await refresh(); setNotice(message); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void operation(async () => {}, ''); }, []);
  const name = (id: string) => options.find(item => item.id === id)?.name || id;
  function edit(persona?: api.Persona) {
    const settings = options.find(item => item.id === persona?.persona_id);
    setFormError(''); setDraft({ id: persona?.persona_id, name: persona ? name(persona.persona_id) : '', prompt: persona?.system_prompt || '', dialogs: structuredClone(persona?.begin_dialogs || []), folder: persona?.folder_id || (folder === '*' ? '' : folder), config: settings?.default_config_id || '', provider: settings?.default_provider_id || '' });
    setChatOptions(undefined); setOptionsBusy(true);
    void listChatOptions(settings?.default_config_id || undefined).then(setChatOptions).catch(reason => setFormError(safeError(reason))).finally(() => setOptionsBusy(false));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return;
    if (!draft.name.trim() || !draft.prompt.trim()) { setFormError('请填写人格名称和系统指令。'); return; }
    if (draft.dialogs.some(item => !item.content.trim())) { setFormError('请补全开场对话，或移除不需要的轮次。'); return; }
    setBusy(true); setFormError('');
    try {
      const id = draft.id || draft.name.trim();
      await api.savePersona({ persona_id: id, system_prompt: draft.prompt, begin_dialogs: draft.dialogs, ...(!draft.id ? { folder_id: draft.folder || null } : {}) }, !!draft.id);
      // Keep the created identity when a later settings request needs a retry.
      if (!draft.id) setDraft(current => current ? { ...current, id } : current);
      await api.savePersonaSettings(id, { display_name: draft.name.trim(), default_config_id: draft.config || null, default_provider_id: draft.provider || null });
      if (draft.id) {
        if ((personas?.find(item => item.persona_id === id)?.folder_id || '') !== draft.folder) await api.movePersona(id, draft.folder || null);
      }
      await refresh(); setDraft(undefined); setNotice('人格已保存，系统指令将在使用这个人格的对话中生效。');
    } catch (reason) { setFormError(safeError(reason)); }
    finally { setBusy(false); }
  }
  const visible = personas?.filter(item => (folder === '*' || (item.folder_id || '') === folder) && (name(item.persona_id) + '\n' + item.system_prompt).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (phrases) return <section className="context-persona-phrases"><button type="button" className="text-button" onClick={() => setPhrases(undefined)}><Icon name="back" size={16} />返回人格</button><h2>{name(phrases)}的快捷短语</h2><QuickPhrases storageId={storageId} personaId={phrases} /></section>;
  return <section aria-label="人格管理">
    <p className="context-intro">为不同的对话留一份独立设定。名称、语气和开场，都从这里开始。</p>
    <div className="context-toolbar"><button type="button" className="primary-button" disabled={busy || !personas} onClick={() => edit()}><Icon name="plus" size={17} />新建人格</button><button type="button" className="text-button" disabled={busy} onClick={() => { setFormError(''); setFolderDraft({ name: '', parent: folder === '*' ? '' : folder }); }}>新建文件夹</button><button type="button" className="text-button" disabled={busy} onClick={() => void operation(async () => {}, '')}>刷新</button></div>
    <div className="context-filters"><label className="dialog-field">查找人格<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称或系统指令" /></label><label className="dialog-field">文件夹<select value={folder} onChange={event => setFolder(event.target.value)}><option value="*">所有人格</option><option value="">未分组</option>{folders.map(item => <option key={item.folder_id} value={item.folder_id}>{item.name}</option>)}</select></label></div>
    {folder !== '*' && folder && <div className="context-actions"><button className="text-button" type="button" disabled={busy} onClick={() => { const current = folders.find(item => item.folder_id === folder); if (current) { setFormError(''); setFolderDraft({ id: current.folder_id, name: current.name, parent: current.parent_id || '' }); } }}>编辑文件夹</button><button className="text-button danger-text" type="button" disabled={busy} onClick={() => setDeleting({ id: folder, name: folders.find(item => item.folder_id === folder)?.name || '', kind: 'folder' })}>删除文件夹</button></div>}
    {error && <div className="context-notice" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={onSettings}>检查人格管理权限</button></div>}{notice && <p className="context-notice" role="status">{notice}</p>}{busy && !personas && <p className="field-help" role="status">正在读取人格…</p>}
    <div className="context-cards">{visible?.map(item => <article className="context-card persona-card" key={item.persona_id}><div className="persona-heading"><span className="persona-initial" aria-hidden="true">{Array.from(name(item.persona_id))[0]}</span><div><h2>{name(item.persona_id)}</h2><span>{folders.find(current => current.folder_id === item.folder_id)?.name || '未分组'} · {item.begin_dialogs.length / 2} 轮开场</span></div></div><p className="context-excerpt">{item.system_prompt}</p><div className="context-actions">{onOpenPersona && <><button className="text-button" type="button" disabled={busy} onClick={() => void operation(() => onOpenPersona(item.persona_id, false), '')}>继续最近对话</button><button className="text-button" type="button" disabled={busy} onClick={() => void operation(() => onOpenPersona(item.persona_id, true), '')}>新窗口</button></>}<button className="text-button" type="button" disabled={busy} onClick={() => edit(item)}>编辑人格</button><button className="text-button" type="button" disabled={busy} onClick={() => setPhrases(item.persona_id)}>快捷短语</button><button className="text-button" type="button" disabled={busy} onClick={() => void operation(() => api.pinPersona(item.persona_id, personas || []), '已移到人格列表最前。')}>移到最前</button><button className="text-button danger-text" type="button" disabled={busy} onClick={() => setDeleting({ id: item.persona_id, name: name(item.persona_id), kind: 'persona' })}>删除人格</button></div></article>)}</div>
    {visible?.length === 0 && <p className="context-empty">{personas?.length ? '没有符合条件的人格。' : '还没有人格。新建一份设定，再开始对话。'}</p>}
    {draft && <Dialog title={draft.id ? '编辑人格' : '新建人格'} onClose={() => { if (!busy) setDraft(undefined); }}><form className="context-form" onSubmit={event => void save(event)}>{formError && <p role="alert" className="message-error">{formError}</p>}<label className="dialog-field">人格名称<input autoFocus required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="dialog-field">文件夹<select value={draft.folder} onChange={event => setDraft({ ...draft, folder: event.target.value })}><option value="">未分组</option>{folders.map(item => <option key={item.folder_id} value={item.folder_id}>{item.name}</option>)}</select></label><label className="dialog-field">系统指令<textarea aria-label="系统指令" required rows={8} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="描述人格的表达方式、背景与对话习惯" /></label><fieldset className="context-fieldset"><legend>新窗口默认线路</legend><p className="field-help">仅用于新建窗口，不覆盖已有会话的选择。</p><label className="dialog-field">默认配置<select aria-label="默认配置" disabled={optionsBusy || busy} value={draft.config} onChange={async event => { const config = event.target.value; setDraft({ ...draft, config, provider: '' }); setOptionsBusy(true); setFormError(''); try { setChatOptions(await listChatOptions(config || undefined)); } catch (reason) { setFormError(safeError(reason)); } finally { setOptionsBusy(false); } }}><option value="">跟随核心默认</option>{chatOptions?.configs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="dialog-field">默认模型<select aria-label="默认模型" disabled={optionsBusy || busy} value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value })}><option value="">跟随会话设置</option>{chatOptions?.providers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>{optionsBusy && <p className="field-help" role="status">正在读取可用线路…</p>}</fieldset><fieldset className="context-fieldset"><legend>开场对话</legend><p className="field-help">作为对话示例提供给模型，每一轮包含用户和助手各一句。</p>{Array.from({ length: draft.dialogs.length / 2 }, (_, index) => <div className="context-opening" key={index}>{(['user', 'assistant'] as const).map((role, offset) => <label className="dialog-field" key={role}>{role === 'user' ? '用户' : '助手'}<textarea rows={3} value={draft.dialogs[index * 2 + offset]?.content || ''} onChange={event => { const dialogs = [...draft.dialogs]; dialogs[index * 2 + offset] = { role, content: event.target.value }; setDraft({ ...draft, dialogs }); }} /></label>)}<button type="button" className="text-button danger-text" onClick={() => setDraft({ ...draft, dialogs: draft.dialogs.filter((_, position) => Math.floor(position / 2) !== index) })}>移除这轮</button></div>)}<button type="button" className="text-button" onClick={() => setDraft({ ...draft, dialogs: [...draft.dialogs, { role: 'user', content: '' }, { role: 'assistant', content: '' }] })}>添加一轮示例</button></fieldset><div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button><button className="primary-button" disabled={busy} type="submit">{busy ? '正在保存…' : '保存人格'}</button></div></form></Dialog>}
    {folderDraft && <Dialog title={folderDraft.id ? '编辑文件夹' : '新建文件夹'} onClose={() => { if (!busy) setFolderDraft(undefined); }}><form className="context-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setFormError(''); try { await api.savePersonaFolder(folderDraft.name.trim(), folderDraft.id, folderDraft.parent || null); await refresh(); setFolderDraft(undefined); } catch (reason) { setFormError(safeError(reason)); } finally { setBusy(false); } }}>{formError && <p className="message-error" role="alert">{formError}</p>}<label className="dialog-field">文件夹名称<input required maxLength={200} value={folderDraft.name} onChange={event => setFolderDraft({ ...folderDraft, name: event.target.value })} /></label><label className="dialog-field">上级文件夹<select value={folderDraft.parent} onChange={event => setFolderDraft({ ...folderDraft, parent: event.target.value })}><option value="">根目录</option>{folders.filter(item => item.folder_id !== folderDraft.id).map(item => <option key={item.folder_id} value={item.folder_id}>{item.name}</option>)}</select></label><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setFolderDraft(undefined)}>取消</button><button type="submit" className="primary-button" disabled={busy}>保存文件夹</button></div></form></Dialog>}
    {deleting && <Dialog title={`删除${deleting.kind === 'persona' ? '人格' : '文件夹'}？`} onClose={() => { if (!busy) setDeleting(undefined); }}><p className="dialog-description">确认删除「{deleting.name}」？{deleting.kind === 'persona' ? '使用这个人格的会话需要重新选择人格。' : '其中的人格与子文件夹将移到根目录。'}</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => { const item = deleting; setDeleting(undefined); void operation(async () => { if (item.kind === 'persona') await api.deletePersona(item.id); else { await api.deletePersonaFolder(item.id); setFolder('*'); } }, '已删除。'); }}>确认删除</button></div></Dialog>}
  </section>;
}
