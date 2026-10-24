import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import * as api from './lib/api';
import type { Attachment, ChatSelection, Connection, CoreStatus, Message, Session, Settings } from './lib/api';
import { Brand, Splash } from './components/Brand';
import { Dialog } from './components/Dialog';
import { EmptyState } from './components/EmptyState';
import { Icon } from './components/Icon';
import { MessageBubble } from './components/MessageBubble';
import { ChatOptionsDialog } from './components/ChatOptionsDialog';
import './styles.css';

type Screen = 'sessions' | 'chat' | 'settings';
const defaultSettings: Settings = { mode: 'cloud', serverUrl: '', apiKey: '' };

export default function App() {
  const [splash, setSplash] = useState(true);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('sessions');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [draft, setDraft] = useState<Settings>(defaultSettings);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [core, setCore] = useState<CoreStatus | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ session: Session; action: 'rename' | 'delete' } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [search, setSearch] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [selections, setSelections] = useState<Record<string, ChatSelection>>({});
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const followLatest = useRef(true);
  const chatPage = useRef<HTMLElement>(null);
  const chatDrafts = useRef<Record<string, { text: string; attachments: Attachment[] }>>({});
  const abort = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composeInput = useRef<HTMLTextAreaElement>(null);
  const finishSplash = useCallback(() => setSplash(false), []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateHeight = () => {
      // Keep the composer above keyboards that resize only the visual viewport.
      // Pinch zoom must remain a browser operation, not relayout the interface.
      if (viewport && Math.abs(viewport.scale - 1) < 0.01) {
        document.documentElement.style.setProperty('--app-viewport-height', `${viewport.height}px`);
      }
    };
    updateHeight();
    viewport?.addEventListener('resize', updateHeight);
    window.addEventListener('resize', updateHeight);
    return () => {
      viewport?.removeEventListener('resize', updateHeight);
      window.removeEventListener('resize', updateHeight);
      document.documentElement.style.removeProperty('--app-viewport-height');
    };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const stored = await api.loadSettings();
        if (!active) return;
        setSettings(stored); setDraft(stored);
        if ((stored.mode === 'cloud' && stored.serverUrl && stored.apiKey) || stored.mode === 'device') {
          try {
            const linked = await api.connect(stored);
            if (!active) return;
            setConnection(linked);
            const history = await api.listSessions();
            if (active) setSessions(history);
          } catch { if (active) setNotice('暂时没有连上核心，请到设置中检查连接。'); }
        }
      } catch { if (active) setNotice('无法读取设置，请重新填写连接信息。'); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; abort.current?.abort(); };
  }, []);

  useEffect(() => {
    if (screen !== 'settings' || draft.mode !== 'device') return;
    let active = true;
    void api.deviceStatus().then((status) => { if (active) setCore(status); }).catch(() => {
      if (active) setCore({ available: false, running: false, message: '暂时无法检测手机内置核心，请稍后重试。' });
    });
    return () => { active = false; };
  }, [screen, draft.mode]);

  useEffect(() => {
    if (followLatest.current) messagesEnd.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages, screen]);

  useEffect(() => {
    const input = composeInput.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(155, Math.max(51, input.scrollHeight))}px`;
  }, [text, screen]);

  useEffect(() => {
    if (selected) chatDrafts.current[selected.id] = { text, attachments };
  }, [selected, text, attachments]);

  const filteredSessions = sessions.filter((session) => session.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const chatSelection = selected ? selections[selected.id] : undefined;
  function goToLatest() {
    followLatest.current = true; setAwayFromLatest(false);
    messagesEnd.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }

  const openSettings = () => { setDraft(settings); setNotice(null); setScreen('settings'); };

  async function refreshSessions() {
    if (!connection) return;
    setBusy('sessions'); setNotice(null);
    try { setSessions(await api.listSessions()); }
    catch { setNotice('会话列表未能加载，请检查连接后重试。'); }
    finally { setBusy(null); }
  }

  async function openSession(session?: Session) {
    if (!connection) { openSettings(); return; }
    if (streaming || busy) return;
    setBusy('session'); setNotice(null);
    try {
      const target = session ?? await api.createSession();
      const history = session ? await api.loadMessages(target.id) : [];
      const savedDraft = chatDrafts.current[target.id];
      followLatest.current = true; setAwayFromLatest(false);
      setSelected(target); setMessages(history); setText(savedDraft?.text || ''); setAttachments(savedDraft?.attachments || []); setScreen('chat');
      if (!session) setSessions((old) => [target, ...old]);
    } catch { setNotice(session ? '这段会话未能打开，请稍后重试。' : '新对话未能创建，请检查连接后重试。'); }
    finally { setBusy(null); }
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    if (busy || streaming) return;
    setBusy('connect'); setNotice(null); api.disconnect(); setConnection(null);
    setSessions([]); setMessages([]); setSelected(null); setAttachments([]);
    chatDrafts.current = {}; setText(''); setSelections({}); setSearch(''); setShowOptions(false);
    try {
      await api.saveSettings(draft); setSettings(draft);
      const linked = await api.connect(draft); setConnection(linked);
      setSessions(await api.listSessions()); setScreen('sessions');
    } catch { setNotice(draft.mode === 'device' ? '手机内置核心尚未连接。请先检查核心状态，再点击连接。' : '连接未成功。请确认地址、API Key 和网络，再试一次。'); }
    finally { setBusy(null); }
  }

  async function startCore() {
    setBusy('core'); setNotice(null);
    try { setCore(await api.startDeviceCore()); }
    catch { setCore({ available: false, running: false, message: '手机内置核心未能启动，请检查此安装包是否包含核心。' }); }
    finally { setBusy(null); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !connection || streaming || busy) return;
    setBusy('upload'); setNotice(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 512 * 1024 * 1024) { setNotice('单个附件不能超过 512 MB，请选择较小的文件。'); continue; }
        const attachment = await api.uploadAttachment(file);
        setAttachments((old) => [...old, attachment]);
      }
    } catch { setNotice('附件未能上传。已上传的附件会保留，可以重新选择其他文件。'); }
    finally { setBusy(null); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !connection || streaming || busy || (!text.trim() && !attachments.length)) return;
    const content = text.trim();
    const sentAttachments = attachments;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const controller = new AbortController(); abort.current = controller;
    let currentAssistantId: string = assistantId;
    let coreError: string | undefined;
    followLatest.current = true; setAwayFromLatest(false);
    setMessages((old) => [...old, { id: userId, role: 'user', text: content, attachments: sentAttachments, status: 'done' }, { id: assistantId, role: 'assistant', text: '', status: 'streaming' }]);
    setText(''); setAttachments([]); setStreaming(true); setNotice(null);
    try {
      await api.sendMessage(selected.id, content, sentAttachments, (chunk) => {
        if (controller.signal.aborted) return;
        if (chunk.type === 'error') coreError = chunk.text;
        const previousId = currentAssistantId;
        if (chunk.type === 'saved' && chunk.messageId) currentAssistantId = chunk.messageId;
        const nextId = currentAssistantId;
        setMessages((old) => old.map((message) => {
          if (message.id !== previousId) return message;
          if (chunk.type === 'text') return { ...message, text: message.text + (chunk.text ?? '') };
          if (chunk.type === 'reasoning') return { ...message, reasoning: (message.reasoning ?? '') + (chunk.text ?? '') };
          if (chunk.type === 'attachment' && chunk.attachment) return { ...message, attachments: [...(message.attachments ?? []), chunk.attachment] };
          if (chunk.type === 'saved') return { ...message, id: nextId };
          if (chunk.type === 'complete') return { ...message, status: 'done' };
          if (chunk.type === 'error') return { ...message, status: 'error' };
          return message;
        }));
      }, controller.signal, chatSelection);
      setMessages((old) => old.map((message) => message.id === currentAssistantId && message.status === 'streaming' ? { ...message, status: 'done' } : message));
      if (!controller.signal.aborted) {
        try { setMessages(await api.loadMessages(selected.id)); }
        catch { setNotice('回复已收到，暂时无法同步保存记录。重新打开会话可再次读取。'); }
      }
      try { setSessions(await api.listSessions()); } catch { /* The delivered reply remains visible if refreshing the list fails. */ }
    } catch {
      setMessages((old) => old.map((message) => message.id === currentAssistantId ? { ...message, status: controller.signal.aborted ? 'done' : 'error' } : message));
      setNotice(controller.signal.aborted ? '已停止接收回复，核心可能仍在处理这条消息。' : coreError || '回复连接中断。已收到的内容会保留，请检查连接后重试。');
    } finally { setStreaming(false); abort.current = null; }
  }

  async function editSession(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy('edit'); setNotice(null);
    try {
      if (editing.action === 'delete') {
        await api.deleteSession(editing.session.id);
        delete chatDrafts.current[editing.session.id];
        setSelections((old) => { const next = { ...old }; delete next[editing.session.id]; return next; });
        setSessions((old) => old.filter((session) => session.id !== editing.session.id));
        if (selected?.id === editing.session.id) { setSelected(null); setMessages([]); setScreen('sessions'); }
      } else {
        await api.renameSession(editing.session.id, newTitle.trim());
        setSessions((old) => old.map((session) => session.id === editing.session.id ? { ...session, title: newTitle.trim() } : session));
        if (selected?.id === editing.session.id) setSelected({ ...selected, title: newTitle.trim() });
      }
      setEditing(null);
    } catch { setNotice('会话修改未成功，请检查连接后重试。'); setEditing(null); }
    finally { setBusy(null); }
  }

  return <div className="app-shell">
    <div className="app-inner" inert={splash ? true : undefined}>
      <header className="topbar">
        {screen === 'chat' ? <button className="icon-button" type="button" aria-label="返回会话列表" onClick={() => setScreen('sessions')}><Icon name="back" /></button> : <Brand />}
        {screen === 'chat' && <div className="chat-heading"><h1>{selected?.title || '新对话'}</h1><span>{settings.mode === 'device' ? '手机内置核心' : '云端 Tillith 核心'}</span></div>}
        <button type="button" className={`connection-pill ${connection ? 'connection-pill--online' : ''}`} onClick={openSettings} disabled={streaming} aria-label="打开连接设置"><span className="status-dot" /><span>{connection ? (settings.mode === 'device' ? '本机' : '云端') : '未连接'}</span></button>
      </header>

      {notice && <div className="notice" role="status"><p>{notice}</p><button className="icon-button" type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" size={16} /></button></div>}

      {screen === 'sessions' && <main className="sessions-page">
        <div className="page-heading"><div><span className="eyebrow">属于你的对话</span><h1>会话</h1></div><button type="button" className="icon-button" onClick={() => void refreshSessions()} disabled={!connection || !!busy} aria-label="刷新会话"><Icon name="refresh" className={busy === 'sessions' ? 'spin' : ''} /></button></div>
        <button type="button" className="new-conversation" onClick={() => void openSession()} disabled={!ready || !!busy || streaming}><span className="new-conversation-icon"><Icon name="plus" size={24} /></span><span><strong>新对话</strong><small>{connection ? '从此刻，开始聊聊' : '先连接你的 Tillith 核心'}</small></span><Icon name="chevron" size={18} /></button>
        {sessions.length > 0 && <label className="session-search"><span className="visually-hidden">搜索会话</span><input type="search" placeholder="搜索会话名称" aria-label="搜索会话" value={search} onChange={(event) => setSearch(event.target.value)} /><span>{filteredSessions.length} 段</span></label>}
        {search.trim() && sessions.length > 0 && filteredSessions.length === 0 && <p className="search-empty" role="status">没有找到这段会话，换个名称试试。</p>}
        {!ready || busy === 'sessions' ? <div className="loading-state"><Icon name="loader" className="spin" />正在读取会话…</div> : sessions.length === 0 ? <EmptyState title={connection ? '第一段对话，从这里开始' : '让 Tillith 与你连接'} action={!connection ? <button type="button" className="text-button" onClick={openSettings}>设置连接 <Icon name="arrow" size={16} /></button> : undefined}><p>{connection ? '点击「新对话」，写下想说的话。' : '选择云端核心，或检查手机内置核心。'}<br />{connection ? '之后的每一次聊天，都会留在这里。' : '连接后，你的会话会出现在这里。'}</p></EmptyState> : <section className="session-section" aria-label="会话列表"><div className="section-label">最近的对话<span>{filteredSessions.length}</span></div><ul className="session-list">{filteredSessions.map((session) => <li className="session-row" key={session.id}><button className="session-open" type="button" onClick={() => void openSession(session)} disabled={!!busy || streaming}><span className="session-icon"><Icon name="chat" /></span><span><strong>{session.title || '未命名对话'}</strong><small>{Number.isNaN(new Date(session.updatedAt).getTime()) ? '已保存的对话' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(session.updatedAt))}</small></span></button><button type="button" className="icon-button" aria-label={`重命名${session.title || '对话'}`} onClick={() => { setNewTitle(session.title); setEditing({ session, action: 'rename' }); }} disabled={streaming}><Icon name="edit" size={17} /></button><button type="button" className="icon-button delete-session" aria-label={`删除${session.title || '对话'}`} onClick={() => setEditing({ session, action: 'delete' })} disabled={streaming}><Icon name="trash" size={17} /></button></li>)}</ul></section>}
        {streaming && selected && <button className="resume-chat" type="button" onClick={() => setScreen('chat')}><Icon name="loader" className="spin" />回复正在继续 · 返回对话<Icon name="chevron" size={16} /></button>}
      </main>}

      {screen === 'chat' && <><div className="chat-tools"><button type="button" className="model-picker" onClick={() => setShowOptions(true)} disabled={!connection || streaming || !!busy}><Icon name="settings" size={15} /><span>{chatSelection?.model || (chatSelection?.configId && chatSelection.configId !== 'default' ? '已选配置 · 默认模型' : '核心默认模型')}</span><Icon name="chevron" size={14} /></button><span>仅此会话</span></div><main ref={chatPage} className="chat-page" aria-label="聊天消息" onScroll={() => { const el = chatPage.current; if (!el) return; const away = el.scrollHeight - el.scrollTop - el.clientHeight > 72; followLatest.current = !away; setAwayFromLatest(away); }}>{messages.length === 0 ? <EmptyState title="想聊些什么？"><p>写下此刻的想法，<br />也可以带上一张图片或一份文件。</p></EmptyState> : <div className="message-list">{messages.map((message) => <MessageBubble key={message.id} message={message} />)}</div>}<div ref={messagesEnd} /></main>{awayFromLatest && <div className="latest-bar"><button type="button" onClick={goToLatest}>回到最新 <Icon name="chevron" size={14} /></button></div>}<form className="composer" onSubmit={(event) => void send(event)}>
        {attachments.length > 0 && <div className="attachment-queue" aria-label="待发送附件">{attachments.map((attachment) => <span className="attachment-chip" key={attachment.id}><Icon name={attachment.type === 'image' ? 'image' : 'file'} size={15} /><span>{attachment.name}</span><button type="button" aria-label={`移除${attachment.name}`} onClick={() => setAttachments((old) => old.filter((item) => item.id !== attachment.id))}><Icon name="close" size={14} /></button></span>)}</div>}
        <div className="composer-field"><textarea ref={composeInput} aria-label="输入消息" placeholder={connection ? '写下想说的话…' : '请先连接核心'} rows={2} value={text} onChange={(event) => setText(event.target.value)} disabled={!connection} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-actions"><input ref={fileInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-label="选择附件" onChange={(event) => void uploadFiles(event.target.files)} /><button type="button" className="icon-button" onClick={() => fileInput.current?.click()} disabled={!connection || !!busy || streaming} aria-label="添加图片、语音或文件"><Icon name={busy === 'upload' ? 'loader' : 'paperclip'} className={busy === 'upload' ? 'spin' : ''} /></button><span className="composer-hint">{busy === 'upload' ? '正在上传附件' : '图片 · 语音 · 文件'}</span>{streaming ? <button type="button" className="send-button" onClick={() => abort.current?.abort()} aria-label="停止接收回复"><Icon name="stop" size={17} /></button> : <button type="submit" className="send-button" disabled={!connection || !!busy || (!text.trim() && !attachments.length)} aria-label="发送消息"><Icon name="arrow" size={21} /></button>}</div></div>
      </form></>}

      {screen === 'settings' && <main className="settings-page"><div className="page-heading"><div><span className="eyebrow">把对话接到你的核心</span><h1>连接设置</h1></div></div><form onSubmit={(event) => void saveConnection(event)}><fieldset className="mode-fieldset"><legend>运行模式</legend><div className="mode-options"><button type="button" className={`mode-option ${draft.mode === 'cloud' ? 'is-selected' : ''}`} aria-pressed={draft.mode === 'cloud'} onClick={() => setDraft({ ...draft, mode: 'cloud' })} disabled={!!busy || streaming}><Icon name="cloud" size={25} /><strong>云端核心</strong><span>连接你的 Tillith 服务器</span>{draft.mode === 'cloud' && <Icon name="check" className="mode-check" size={14} />}</button><button type="button" className={`mode-option ${draft.mode === 'device' ? 'is-selected' : ''}`} aria-pressed={draft.mode === 'device'} onClick={() => setDraft({ ...draft, mode: 'device' })} disabled={!!busy || streaming}><Icon name="device" size={25} /><strong>手机内置核心</strong><span>在这台手机中运行</span>{draft.mode === 'device' && <Icon name="check" className="mode-check" size={14} />}</button></div></fieldset>
        {draft.mode === 'cloud' ? <section className="settings-section"><label htmlFor="server-url">服务器地址</label><input id="server-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://你的服务器地址" value={draft.serverUrl} onChange={(event) => setDraft({ ...draft, serverUrl: event.target.value })} required disabled={!!busy} /><p className="field-help">填写你自己的 Tillith 云端核心地址。</p><label htmlFor="api-key">API Key</label><input id="api-key" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="粘贴连接密钥" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} required disabled={!!busy} /><p className="field-help">聊天身份由核心验证，无需另外填写用户名。</p></section> : <section className="core-state"><div className="core-state-heading"><span className={`status-dot ${core?.running ? 'status-dot--online' : ''}`} /><strong>{core ? (core.running ? '核心正在运行' : core.available ? '核心尚未启动' : '内置核心暂不可用') : '正在检测核心'}</strong></div><p>{core?.message || '正在检查这台手机的核心状态…'}</p><button type="button" className="secondary-button" disabled={!!busy || core?.running} onClick={() => void startCore()}><Icon name={busy === 'core' ? 'loader' : 'refresh'} className={busy === 'core' ? 'spin' : ''} size={17} />{busy === 'core' ? '正在启动…' : core?.available ? '启动内置核心' : '检查并启动'}</button></section>}
        <button type="submit" className="primary-button connect-button" disabled={!!busy || streaming || (draft.mode === 'device' && !core?.running)}>{busy === 'connect' ? <><Icon name="loader" className="spin" size={18} />正在连接…</> : <><Icon name="check" size={18} />保存并连接</>}</button><p className="settings-footnote">云端与手机模式使用各自的核心。<br />切换连接后，会话列表随当前核心更新。</p>
      </form>{connection && <div className="connected-details"><span className="status-dot status-dot--online" /><span>已连接{settings.mode === 'device' ? '手机内置核心' : '云端核心'}</span></div>}</main>}

      {screen !== 'chat' && <nav className="bottom-nav" aria-label="主导航"><button type="button" className={screen === 'sessions' ? 'is-active' : ''} aria-current={screen === 'sessions' ? 'page' : undefined} onClick={() => setScreen('sessions')}><Icon name="chat" /><span>会话</span></button><button type="button" className={screen === 'settings' ? 'is-active' : ''} aria-current={screen === 'settings' ? 'page' : undefined} onClick={openSettings} disabled={streaming}><Icon name="settings" /><span>设置</span></button></nav>}
    </div>
    {showOptions && selected && <ChatOptionsDialog value={chatSelection} onClose={() => setShowOptions(false)} onApply={(value) => { setSelections((old) => ({ ...old, [selected.id]: value })); setShowOptions(false); }} />}
    {editing && <Dialog title={editing.action === 'rename' ? '重命名会话' : '删除这段会话？'} onClose={() => { if (!busy) setEditing(null); }}><form onSubmit={(event) => void editSession(event)}>{editing.action === 'rename' ? <label className="dialog-field">会话名称<input autoFocus value={newTitle} maxLength={100} required onChange={(event) => setNewTitle(event.target.value)} /></label> : <p className="dialog-description">「{editing.session.title || '未命名对话'}」及其中的消息将从当前核心删除，此操作无法撤销。</p>}<div className="dialog-actions"><button className="secondary-button" type="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button><button className={editing.action === 'delete' ? 'danger-button' : 'primary-button'} type="submit" disabled={!!busy || (editing.action === 'rename' && !newTitle.trim())}>{busy === 'edit' ? '正在保存…' : editing.action === 'delete' ? '删除会话' : '保存名称'}</button></div></form></Dialog>}
    {splash && <Splash onFinish={finishSplash} />}
  </div>;
}
