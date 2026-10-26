import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import * as api from './lib/api';
import type { Attachment, ChatSelection, Connection, CoreStatus, Message, Session, SessionMeta, Settings } from './lib/api';
import { Brand, Splash } from './components/Brand';
import { Dialog } from './components/Dialog';
import { EmptyState } from './components/EmptyState';
import { Icon } from './components/Icon';
import { MessageBubble } from './components/MessageBubble';
import { ChatOptionsDialog } from './components/ChatOptionsDialog';
import { AppearancePanel } from './components/AppearancePanel';
import { MessageSearchDialog } from './components/MessageSearchDialog';
import { SessionList } from './components/SessionList';
import { MessageActionsDialog, type MessageAction } from './components/MessageActionsDialog';
import { MessageVersionsDialog } from './components/MessageVersionsDialog';
import { exportConversation } from './lib/export';
import { ProviderWorkspace } from './components/ProviderWorkspace';
import { ToolsWorkspace } from './components/ToolsWorkspace';
import { ServerProfilesPanel } from './components/ServerProfilesPanel';
import { deleteProfile, loadProfiles, profileSettings } from './lib/profiles';
import { ContextWorkspace } from './components/ContextWorkspace';
import { SessionContextPanel } from './components/SessionContextPanel';
import { QuickPhrases } from './components/QuickPhrases';
import { RememberMessageDialog } from './components/RememberMessageDialog';
import { getPersonaSettings, updateSessionContext, type SessionContext } from './lib/context-api';
import { prepareAttachment } from './lib/attachments';
import { loadAppearance, loadChatPreferences, saveChatPreferences, type Appearance } from './lib/preferences';
import './styles.css';
import './themes.css';

type Screen = 'sessions' | 'chat' | 'settings' | 'more' | 'providers' | 'context' | 'tools';
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
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ session: Session; action: 'rename' | 'delete' } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [search, setSearch] = useState('');
  const [sessionMeta, setSessionMeta] = useState<Record<string, SessionMeta>>({});
  const [sessionFilter, setSessionFilter] = useState<'all' | 'starred' | 'archived'>('all');
  const [managingSession, setManagingSession] = useState<Session | null>(null);
  const [searchMessages, setSearchMessages] = useState(false);
  const [appearance, setAppearance] = useState(loadAppearance);
  const [attachmentPicker, setAttachmentPicker] = useState(false);
  const [managingMessage, setManagingMessage] = useState<Message | null>(null);
  const [versionMessage, setVersionMessage] = useState<Message | null>(null);
  const [exportingSession, setExportingSession] = useState<Session | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
  const [contextReturn, setContextReturn] = useState<'more' | 'chat'>('more');
  const [showPhrases, setShowPhrases] = useState(false);
  const [rememberingMessage, setRememberingMessage] = useState<Message | null>(null);
  const [selections, setSelections] = useState<Record<string, ChatSelection>>({});
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const followLatest = useRef(true);
  const focusMessage = useRef<string | null>(null);
  const storageWarning = useRef(false);
  const chatPage = useRef<HTMLElement>(null);
  const chatDrafts = useRef<Record<string, { text: string; attachments: Attachment[] }>>({});
  const abort = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const composeInput = useRef<HTMLTextAreaElement>(null);
  const finishSplash = useCallback(() => setSplash(false), []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = appearance.theme === 'system' ? (media.matches ? 'dark' : 'light') : appearance.theme;
      document.documentElement.dataset.codeTheme = appearance.codeTheme;
      document.documentElement.style.setProperty('--message-font-size', `${appearance.fontSize}px`);
      document.documentElement.style.setProperty('--message-gap', `${appearance.density === 'compact' ? 16 : appearance.density === 'spacious' ? 38 : 26}px`);
    };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appearance]);

  function changeAppearance(value: Appearance) {
    setAppearance(value);
    try { localStorage.setItem('tillith.appearance', JSON.stringify(value)); }
    catch { setNotice('当前无法保存外观，重启后会恢复原设置。'); }
  }

  function restoreChatPreferences(linked: Connection) {
    const saved = loadChatPreferences(linked);
    chatDrafts.current = saved.drafts; setSelections(saved.selections);
    storageWarning.current = false;
  }

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
        if ((stored.mode === 'cloud' && (stored.serverUrl || !Capacitor.isNativePlatform()) && stored.apiKey) || stored.mode === 'device') {
          try {
            const linked = await api.connect(stored);
            if (!active) return;
            setConnection(linked);
            restoreChatPreferences(linked);
            const [history, metadata] = await Promise.all([api.listSessions(), api.listSessionMeta()]);
            if (active) { setSessions(history); setSessionMeta(Object.fromEntries(metadata.map((item) => [item.session_id, item]))); }
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
    if (screen !== 'settings' || draft.mode !== 'device' || core?.state !== 'starting') return;
    let active = true;
    const timer = window.setInterval(() => { void api.deviceStatus().then((state) => { if (active) setCore(state); }).catch(() => {}); }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [screen, draft.mode, core?.state]);

  useEffect(() => {
    if (screen === 'chat' && focusMessage.current) {
      const target = document.getElementById('message-' + focusMessage.current);
      if (target) { followLatest.current = false; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); focusMessage.current = null; return; }
    }
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
    if (connection && !saveChatPreferences(connection, chatDrafts.current, selections) && !storageWarning.current) {
      storageWarning.current = true; setNotice('本机存储空间不足或不可用，草稿与模型选择暂时只能保留到关闭页面。');
    }
  }, [selected, text, attachments, selections, connection]);

  const filteredSessions = sessions.filter((session) => {
    const meta = sessionMeta[session.id];
    return (sessionFilter === 'archived' ? meta?.archived : !meta?.archived && (sessionFilter !== 'starred' || meta?.starred)) && session.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  }).sort((a, b) => Number(!!sessionMeta[b.id]?.pinned) - Number(!!sessionMeta[a.id]?.pinned));
  const chatSelection = selected ? selections[selected.id] : undefined;
  function goToLatest() {
    followLatest.current = true; setAwayFromLatest(false);
    messagesEnd.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }

  const openSettings = () => { setDraft(settings); setNotice(null); setScreen('settings'); };

  async function refreshSessions() {
    if (!connection) return;
    setBusy('sessions'); setNotice(null);
    try { const [history, metadata] = await Promise.all([api.listSessions(), api.listSessionMeta()]); setSessions(history); setSessionMeta(Object.fromEntries(metadata.map((item) => [item.session_id, item]))); }
    catch { setNotice('会话列表未能加载，请检查连接后重试。'); }
    finally { setBusy(null); }
  }

  async function openSession(session?: Session, messageId?: string, personaId?: string, continuePersona = false) {
    if (!connection) { openSettings(); return; }
    if (streaming || busy) return;
    setBusy('session'); setNotice(null);
    try {
      let target = session;
      if (continuePersona && personaId) {
        const [history, result] = await Promise.all([api.listSessions(), api.chatRequest(`/tillith/personas/${encodeURIComponent(personaId)}/sessions`)]);
        setSessions(history);
        target = (result.session_ids as string[]).map((id) => history.find((item) => item.id === id)).find((item) => !!item);
      }
      const creating = !target;
      let personaSelection: ChatSelection | undefined;
      if (creating && personaId) {
        const defaults = await getPersonaSettings(personaId);
        if (defaults.default_config_id || defaults.default_provider_id) {
          const options = await api.listChatOptions(defaults.default_config_id || undefined);
          const provider = options.providers.find((item) => item.id === defaults.default_provider_id);
          personaSelection = { configId: defaults.default_config_id || options.default_config_id, providerId: provider?.id || '', model: provider?.model || '', streaming: true };
          if (defaults.default_provider_id && !provider) setNotice('这个人格的默认模型已不可用，新窗口暂跟随核心默认。请在模型选择中确认后再发送。');
        }
      }
      target ??= await api.createSession();
      if (creating && personaId) {
        try { await updateSessionContext(target.id, { persona_id: personaId }); }
        catch (reason) { await api.deleteSession(target.id).catch(() => {}); throw reason; }
      }
      const loaded = creating ? { messages: [], activeRuns: [], hasMore: false } : await api.loadSession(target.id, messageId);
      setHasOlderMessages(loaded.hasMore);
      const savedDraft = chatDrafts.current[target.id];
      focusMessage.current = messageId || null;
      followLatest.current = true; setAwayFromLatest(false);
      setSelected(target); setMessages(loaded.messages); setText(savedDraft?.text || ''); setAttachments(savedDraft?.attachments || []); setScreen('chat');
      setSessionContext(null); setShowPhrases(false); setRememberingMessage(null);
      if (creating) { const created = target; setSessions((old) => [created, ...old]); }
      if (personaSelection) { const id = target.id, preference = personaSelection; setSelections((old) => ({ ...old, [id]: preference })); }
      if (loaded.activeRuns.length) void runChat({ type: 'resume', sessionId: target.id, runId: loaded.activeRuns[0].run_id }, loaded.messages, selections[target.id]);
    } catch (reason) { setNotice(api.safeError(reason)); }
    finally { setBusy(null); }
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    await connectSettings(draft);
  }

  async function connectSettings(nextSettings: Settings) {
    if (busy || streaming) return;
    setBusy('connect'); setNotice(null); api.disconnect(); setConnection(null);
    setSessions([]); setMessages([]); setSelected(null); setAttachments([]);
    chatDrafts.current = {}; setText(''); setSelections({}); setSearch(''); setShowOptions(false);
    setSessionMeta({}); setSessionFilter('all');
    setSessionContext(null); setShowPhrases(false); setRememberingMessage(null);
    try {
      await api.saveSettings(nextSettings); setSettings(nextSettings); setDraft(nextSettings);
      const linked = await api.connect(nextSettings); restoreChatPreferences(linked); setConnection(linked);
      const [history, metadata] = await Promise.all([api.listSessions(), api.listSessionMeta()]);
      setSessions(history); setSessionMeta(Object.fromEntries(metadata.map((item) => [item.session_id, item]))); setScreen('sessions');
    } catch (error) { setNotice(api.safeError(error)); }
    finally { setBusy(null); }
  }

  async function startCore() {
    setBusy('core'); setNotice(null);
    try { setCore(await api.startDeviceCore()); }
    catch { setCore({ available: false, running: false, message: '手机内置核心未能启动，请检查此安装包是否包含核心。' }); }
    finally { setBusy(null); }
  }

  async function removeServerProfile(id: string) {
    if (busy || streaming) return;
    setBusy('profile');
    try {
      await deleteProfile(id);
      if (settings.profileId === id) {
        api.disconnect(); setConnection(null); setSettings(defaultSettings);
        setSessions([]); setSelected(null); setMessages([]); setHasOlderMessages(false);
        setText(''); setAttachments([]); chatDrafts.current = {}; setSelections({});
        setSessionMeta({}); setSearch(''); setSessionFilter('all'); setShowOptions(false);
        setManagingMessage(null); setVersionMessage(null); setManagingSession(null);
        setExportingSession(null); setSearchMessages(false); setEditing(null);
        setSessionContext(null); setShowPhrases(false); setRememberingMessage(null);
        const profiles = await loadProfiles();
        const next = await profileSettings(profiles.activeProfileId);
        setSettings(next); setDraft(next);
        setNotice('已移除当前配置并断开连接。请选择要使用的配置，再连接核心。');
      }
    } finally { setBusy(null); }
  }

  async function changeSessionMeta(session: Session, patch: Partial<Pick<SessionMeta, 'pinned' | 'starred' | 'archived'>>) {
    setBusy('metadata'); setNotice(null);
    try { const next = await api.updateSessionMeta(session.id, patch); setSessionMeta((old) => ({ ...old, [session.id]: next })); setManagingSession(null); }
    catch (error) { setNotice(api.safeError(error)); setManagingSession(null); }
    finally { setBusy(null); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !connection || streaming || busy) return;
    setBusy('upload'); setNotice(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 512 * 1024 * 1024) { setNotice('单个附件不能超过 512 MB，请选择较小的文件。'); continue; }
        const attachment = await api.uploadAttachment(await prepareAttachment(file));
        setAttachments((old) => [...old, attachment]);
      }
    } catch (error) { setNotice(api.safeError(error) + ' 已上传的附件会保留。'); }
    finally { setBusy(null); for (const ref of [fileInput, cameraInput, albumInput]) if (ref.current) ref.current.value = ''; }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !connection || streaming || busy || (!text.trim() && !attachments.length)) return;
    const action: api.ChatAction = { type: 'send', sessionId: selected.id, text: text.trim(), attachments };
    setText(''); setAttachments([]);
    await runChat(action, messages, chatSelection);
  }

  async function runChat(action: api.ChatAction, history: Message[], selection?: ChatSelection) {
    const assistantId = crypto.randomUUID();
    let userId = action.type === 'send' ? crypto.randomUUID() : [...history].reverse().find((item) => item.role === 'user')?.id;
    let next = [...history];
    if (action.type === 'send') next.push({ id: userId!, role: 'user', text: action.text, attachments: action.attachments, status: 'done' });
    if (action.type === 'edit' || action.type === 'regenerate') {
      const userIndex = next.length - 1 - [...next].reverse().findIndex((item) => item.role === 'user');
      next = next.slice(0, userIndex + 1);
      if (action.type === 'edit' && next[userIndex]) next[userIndex] = { ...next[userIndex], text: api.messageFromContent(action.content).text };
    }
    const controller = new AbortController(); abort.current = controller;
    let currentAssistantId: string = assistantId;
    let coreError: string | undefined;
    followLatest.current = true; setAwayFromLatest(false);
    setMessages([...next, { id: assistantId, role: 'assistant', text: '', status: 'streaming' }]);
    setStreaming(true); setNotice(null);
    try {
      await api.streamChat(action, (chunk) => {
        if (controller.signal.aborted) return;
        if (chunk.type === 'error') coreError = chunk.text;
        if (chunk.type === 'user_saved' && chunk.messageId) {
          const previousUserId = userId; userId = chunk.messageId;
          setMessages((old) => old.map((message) => message.id === previousUserId ? { ...message, id: chunk.messageId!, saved: true, checkpointId: chunk.checkpointId } : message));
          return;
        }
        const previousId = currentAssistantId;
        if (chunk.type === 'saved' && chunk.messageId) currentAssistantId = chunk.messageId;
        const nextId = currentAssistantId;
        setMessages((old) => old.map((message) => {
          if (message.id !== previousId) return message;
          if (chunk.type === 'snapshot' && chunk.message) return { ...chunk.message, id: previousId, status: 'streaming' };
          if (chunk.type === 'text') return { ...message, text: message.text + (chunk.text ?? '') };
          if (chunk.type === 'reasoning') return { ...message, reasoning: (message.reasoning ?? '') + (chunk.text ?? '') };
          if (chunk.type === 'attachment' && chunk.attachment) return { ...message, attachments: [...(message.attachments ?? []), chunk.attachment] };
          if (chunk.type === 'saved') return { ...message, id: nextId, saved: true, checkpointId: chunk.checkpointId };
          if (chunk.type === 'usage') return { ...message, usage: chunk.usage };
          if (chunk.type === 'complete') return { ...message, status: 'done' };
          if (chunk.type === 'error') return { ...message, status: 'error' };
          return message;
        }));
      }, controller.signal, selection);
      setMessages((old) => old.map((message) => message.id === currentAssistantId && message.status === 'streaming' ? { ...message, status: 'done' } : message));
      if (!controller.signal.aborted) {
        try { setMessages((await api.loadSession(action.sessionId)).messages); }
        catch { setNotice('回复已收到，暂时无法同步保存记录。重新打开会话可再次读取。'); }
      }
      try { setSessions(await api.listSessions()); } catch { /* The delivered reply remains visible if refreshing the list fails. */ }
    } catch (error) {
      setMessages((old) => old.map((message) => message.id === currentAssistantId ? { ...message, status: controller.signal.aborted ? 'done' : 'error' } : message));
      setNotice(controller.signal.aborted ? '已请求停止回复。' : coreError || api.safeError(error));
      try {
        const loaded = await api.loadSession(action.sessionId);
        if (!loaded.activeRuns.length) setMessages((previous) => {
          const partial = previous.find((item) => item.id === currentAssistantId && !item.saved && (item.text || item.reasoning || item.attachments?.length));
          return partial ? [...loaded.messages, { ...partial, status: 'error' }] : loaded.messages;
        });
      } catch { /* Preserve received content while the server is unavailable. */ }
    } finally { setStreaming(false); abort.current = null; }
  }

  async function messageAction(action: MessageAction, editedText?: string) {
    if (!selected || !managingMessage || busy || streaming) return;
    const message = managingMessage;
    if (action === 'memory') { setRememberingMessage(message); setManagingMessage(null); return; }
    if (action === 'versions') { setVersionMessage(message); setManagingMessage(null); return; }
    if (action === 'edit' || action === 'regenerate') {
      setManagingMessage(null);
      const retryUser = action === 'regenerate' && !message.saved ? [...messages].reverse().find((item) => item.role === 'user' && item.saved && item.checkpointId) : undefined;
      const editTarget = retryUser || message;
      const command: api.ChatAction = action === 'edit' || retryUser ? { type: 'edit', sessionId: selected.id, messageId: editTarget.id, content: { type: 'user', message: [{ type: 'plain', text: retryUser ? retryUser.text : editedText || '' }, ...(editTarget.attachments || []).map((item) => ({ type: item.type, attachment_id: item.id, filename: item.name }))] } } : { type: 'regenerate', sessionId: selected.id, messageId: message.id };
      await runChat(command, messages, chatSelection); return;
    }
    setBusy('message'); setNotice(null);
    try {
      if (action === 'delete') { await api.deleteTurn(selected.id, message.id); setMessages((await api.loadSession(selected.id)).messages); }
      if (action === 'branch') {
        const answer = message.role === 'assistant' ? message : messages.find((item) => item.role === 'assistant' && item.checkpointId === message.checkpointId);
        if (!answer?.saved) throw new Error('这一轮还没有保存的回答，暂时无法创建分支。');
        const branch = await api.branchSession(selected.id, answer.id);
        const list = await api.listSessions(); setSessions(list);
        const target = list.find((item) => item.id === branch.session_id);
        if (!target) throw new Error('分支已创建，请刷新会话列表。');
        setSelected(target); setMessages((await api.loadSession(target.id)).messages); setText(''); setAttachments([]);
        if (chatSelection) setSelections((old) => ({ ...old, [target.id]: chatSelection }));
      }
      setManagingMessage(null);
    } catch (error) { setNotice(api.safeError(error)); setManagingMessage(null); }
    finally { setBusy(null); }
  }

  async function exportSession(format: 'json' | 'md' | 'backup') {
    if (!exportingSession || busy) return;
    setBusy('export');
    try { const saved = await exportConversation(exportingSession, format); setNotice(saved ? (format === 'backup' ? '对话备份已导出。' : '会话已导出。') : '已取消导出。'); }
    catch (error) { setNotice(api.safeError(error)); }
    finally { setBusy(null); setExportingSession(null); }
  }

  async function loadOlderMessages() {
    if (!selected || busy || streaming) return;
    setBusy('history');
    const first = messages[0]?.id;
    try { const history = await api.loadMessages(selected.id); focusMessage.current = first || null; setMessages(history); setHasOlderMessages(false); }
    catch (error) { setNotice(api.safeError(error)); }
    finally { setBusy(null); }
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
        {connection && <div className="session-filter-row"><div className="filter-tabs" aria-label="会话筛选">{([['all', '全部'], ['starred', '星标'], ['archived', '归档']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={sessionFilter === value} className={sessionFilter === value ? 'is-active' : ''} onClick={() => setSessionFilter(value)}>{label}</button>)}</div><button type="button" className="text-button" onClick={() => setSearchMessages(true)} disabled={streaming || !!busy}>搜索消息</button></div>}
        {sessions.length > 0 && filteredSessions.length === 0 && <p className="search-empty" role="status">{search.trim() ? '没有找到这段会话，换个名称试试。' : sessionFilter === 'archived' ? '还没有归档的会话。' : sessionFilter === 'starred' ? '还没有星标会话，可从会话菜单中添加。' : '会话已归档，可切换到归档查看。'}</p>}
        {!ready || busy === 'sessions' ? <div className="loading-state"><Icon name="loader" className="spin" />正在读取会话…</div> : sessions.length === 0 ? <EmptyState title={connection ? '第一段对话，从这里开始' : '让 Tillith 与你连接'} action={!connection ? <button type="button" className="text-button" onClick={openSettings}>设置连接 <Icon name="arrow" size={16} /></button> : undefined}><p>{connection ? '点击「新对话」，写下想说的话。' : '选择云端核心，或检查手机内置核心。'}<br />{connection ? '之后的每一次聊天，都会留在这里。' : '连接后，你的会话会出现在这里。'}</p></EmptyState> : <SessionList sessions={filteredSessions} metadata={sessionMeta} disabled={!!busy || streaming} onOpen={(session) => void openSession(session)} onManage={setManagingSession} />}
        {streaming && selected && <button className="resume-chat" type="button" onClick={() => setScreen('chat')}><Icon name="loader" className="spin" />回复正在继续 · 返回对话<Icon name="chevron" size={16} /></button>}
      </main>}

      {screen === 'chat' && <><div className="chat-tools"><button type="button" className="model-picker" onClick={() => setShowOptions(true)} disabled={!connection || streaming || !!busy}><Icon name="settings" size={15} /><span>{chatSelection?.model || (chatSelection?.configId && chatSelection.configId !== 'default' ? '已选配置 · 默认模型' : '核心默认模型')}</span><Icon name="chevron" size={14} /></button><span>仅此会话</span></div>{selected && <SessionContextPanel key={selected.id} sessionId={selected.id} disabled={streaming || !!busy} onChange={setSessionContext} onManage={() => { setContextReturn('chat'); setScreen('context'); }} onNewPersonaSession={(id) => openSession(undefined, undefined, id)} />}<main ref={chatPage} className="chat-page" aria-label="聊天消息" onScroll={() => { const el = chatPage.current; if (!el) return; const away = el.scrollHeight - el.scrollTop - el.clientHeight > 72; followLatest.current = !away; setAwayFromLatest(away); }}>{messages.length === 0 ? <EmptyState title="想聊些什么？"><p>写下此刻的想法，<br />也可以带上一张图片或一份文件。</p></EmptyState> : <div className="message-list">{hasOlderMessages && <button type="button" className="text-button" disabled={!!busy || streaming} onClick={() => void loadOlderMessages()}>载入更早的消息</button>}{messages.map((message) => <MessageBubble key={message.id} message={message} disabled={streaming || !!busy} onManage={() => setManagingMessage(message)} />)}</div>}<div ref={messagesEnd} /></main>{awayFromLatest && <div className="latest-bar"><button type="button" onClick={goToLatest}>回到最新 <Icon name="chevron" size={14} /></button></div>}<form className="composer" onSubmit={(event) => void send(event)}>
        {attachments.length > 0 && <div className="attachment-queue" aria-label="待发送附件">{attachments.map((attachment) => <span className="attachment-chip" key={attachment.id}><Icon name={attachment.type === 'image' ? 'image' : 'file'} size={15} /><span>{attachment.name}</span><button type="button" aria-label={`移除${attachment.name}`} onClick={() => setAttachments((old) => old.filter((item) => item.id !== attachment.id))}><Icon name="close" size={14} /></button></span>)}</div>}
        <div className="composer-field"><textarea ref={composeInput} aria-label="输入消息" placeholder={connection ? '写下想说的话…' : '请先连接核心'} rows={2} value={text} onChange={(event) => setText(event.target.value)} disabled={!connection} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-actions"><input ref={fileInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-label="选择附件" onChange={(event) => void uploadFiles(event.target.files)} /><button type="button" className="icon-button" onClick={() => setAttachmentPicker(true)} disabled={!connection || !!busy || streaming} aria-label="添加图片、语音或文件"><Icon name={busy === 'upload' ? 'loader' : 'paperclip'} className={busy === 'upload' ? 'spin' : ''} /></button><button type="button" className="icon-button" aria-label="快捷短语" disabled={!connection || !!busy || streaming} onClick={() => { if (sessionContext?.persona_id) setShowPhrases(true); else setNotice('请先在“人格与世界书”中选择人格，再使用它的快捷短语。'); }}><Icon name="bolt" size={18} /></button><span className="composer-hint">{busy === 'upload' ? '正在上传附件' : '图片 · 语音 · 文件'}</span>{streaming ? <button type="button" className="send-button" onClick={() => abort.current?.abort()} aria-label="停止接收回复"><Icon name="stop" size={17} /></button> : <button type="submit" className="send-button" disabled={!connection || !!busy || (!text.trim() && !attachments.length)} aria-label="发送消息"><Icon name="arrow" size={21} /></button>}</div></div>
      </form></>}

      {screen === 'settings' && <main className="settings-page"><div className="page-heading"><div><span className="eyebrow">把对话接到你的核心</span><h1>连接设置</h1></div></div><ServerProfilesPanel value={draft} disabled={!!busy || streaming} onChange={setDraft} onConnect={connectSettings} onRemove={removeServerProfile} /><form onSubmit={(event) => void saveConnection(event)}><fieldset className="mode-fieldset"><legend>运行模式</legend><div className="mode-options"><button type="button" className={`mode-option ${draft.mode === 'cloud' ? 'is-selected' : ''}`} aria-pressed={draft.mode === 'cloud'} onClick={() => setDraft({ ...draft, mode: 'cloud' })} disabled={!!busy || streaming}><Icon name="cloud" size={25} /><strong>云端核心</strong><span>连接你的 Tillith 服务器</span>{draft.mode === 'cloud' && <Icon name="check" className="mode-check" size={14} />}</button><button type="button" className={`mode-option ${draft.mode === 'device' ? 'is-selected' : ''}`} aria-pressed={draft.mode === 'device'} onClick={() => setDraft({ ...draft, mode: 'device' })} disabled={!!busy || streaming}><Icon name="device" size={25} /><strong>手机内置核心</strong><span>在这台手机中运行</span>{draft.mode === 'device' && <Icon name="check" className="mode-check" size={14} />}</button></div></fieldset>
        {draft.mode === 'cloud' ? <section className="settings-section"><label htmlFor="server-url">服务器地址</label><input id="server-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://你的服务器地址" value={draft.serverUrl} onChange={(event) => setDraft({ ...draft, serverUrl: event.target.value })} required={Capacitor.isNativePlatform()} disabled={!!busy} /><p className="field-help">填写你自己的 Tillith 云端核心地址。</p><label htmlFor="api-key">API Key</label><input id="api-key" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="粘贴连接密钥" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} required disabled={!!busy} /><p className="field-help">聊天身份由核心验证，无需另外填写用户名。</p></section> : <section className="core-state"><div className="core-state-heading"><span className={`status-dot ${core?.running ? 'status-dot--online' : ''}`} /><strong>{core ? (core.running ? '核心正在运行' : core.restartRequired ? '需重新打开 Tillith' : core.state === 'starting' ? '核心正在启动' : core.available ? '核心尚未启动' : '内置核心暂不可用') : '正在检测核心'}</strong></div><p>{core?.message || '正在检查这台手机的核心状态…'}</p><button type="button" className="secondary-button" disabled={!!busy || core?.running || core?.restartRequired || core?.state === 'starting'} onClick={() => void startCore()}><Icon name={busy === 'core' ? 'loader' : 'refresh'} className={busy === 'core' ? 'spin' : ''} size={17} />{busy === 'core' || core?.state === 'starting' ? '正在启动…' : core?.restartRequired ? '需重新打开 Tillith' : core?.available ? '启动内置核心' : '检查并启动'}</button></section>}
        <section className="settings-section management-settings"><label htmlFor="management-key">管理 API Key</label><input id="management-key" type="password" autoComplete="off" spellCheck={false} placeholder="管理功能使用独立密钥" value={draft.managementKey || ''} onChange={(event) => setDraft({ ...draft, managementKey: event.target.value })} disabled={!!busy} /><p className="field-help">与聊天密钥分开保存。线路管理需要 provider、人格管理需要 persona、工具与 MCP 需要 mcp、对话备份需要 data 权限。</p></section><button type="submit" className="primary-button connect-button" disabled={!!busy || streaming || (draft.mode === 'device' && !core?.running)}>{busy === 'connect' ? <><Icon name="loader" className="spin" size={18} />正在连接…</> : <><Icon name="check" size={18} />保存并连接</>}</button><p className="settings-footnote">云端与手机模式使用各自的核心。<br />切换连接后，会话列表随当前核心更新。</p>
      </form>{connection && <div className="connected-details"><span className="status-dot status-dot--online" /><span>已连接{settings.mode === 'device' ? '手机内置核心' : '云端核心'}</span></div>}</main>}

      {screen === 'more' && <main className="settings-page"><div className="page-heading"><div><span className="eyebrow">{new Date().getHours() < 6 ? '夜深了，慢慢聊' : new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'}</span><h1>更多</h1></div></div><button type="button" className="more-entry" disabled={!connection || streaming} onClick={() => setScreen('providers')}><Icon name="settings" /><span>线路与模型<small>管理服务、模型和参数</small></span><Icon name="chevron" size={17} /></button><button type="button" className="more-entry" disabled={!connection || streaming} onClick={() => { setContextReturn('more'); setScreen('context'); }}><Icon name="chat" /><span>人格、世界书与记忆<small>独立窗口、提示词和上下文来源</small></span><Icon name="chevron" size={17} /></button><button type="button" className="more-entry" disabled={!connection || streaming} onClick={() => setScreen('tools')}><Icon name="bolt" /><span>工具与 MCP<small>允许的工具、远程服务与连接检查</small></span><Icon name="chevron" size={17} /></button><AppearancePanel value={appearance} onChange={changeAppearance} /></main>}
      {screen === 'tools' && connection && <ToolsWorkspace key={connection.storageId} onBack={() => setScreen('more')} onSettings={openSettings} />}
      {screen === 'providers' && <ProviderWorkspace onBack={() => setScreen('more')} onSettings={openSettings} />}
      {screen === 'context' && connection && <ContextWorkspace storageId={connection.storageId} backLabel={contextReturn === 'chat' ? '返回对话' : '更多'} onBack={() => setScreen(contextReturn)} onSettings={openSettings} sessionId={selected?.id} onOpenPersona={(id, newWindow) => openSession(undefined, undefined, id, !newWindow)} />}
      {screen !== 'chat' && <nav className="bottom-nav" aria-label="主导航"><button type="button" className={screen === 'sessions' ? 'is-active' : ''} aria-current={screen === 'sessions' ? 'page' : undefined} onClick={() => setScreen('sessions')}><Icon name="chat" /><span>会话</span></button><button type="button" className={screen === 'more' || screen === 'providers' || screen === 'context' || screen === 'tools' ? 'is-active' : ''} aria-current={screen === 'more' ? 'page' : undefined} onClick={() => setScreen('more')}><Icon name="more" /><span>更多</span></button><button type="button" className={screen === 'settings' ? 'is-active' : ''} aria-current={screen === 'settings' ? 'page' : undefined} onClick={openSettings} disabled={streaming}><Icon name="settings" /><span>设置</span></button></nav>}
    </div>
    {showPhrases && connection && sessionContext?.persona_id && <Dialog title="快捷短语" onClose={() => setShowPhrases(false)}><QuickPhrases storageId={connection.storageId} personaId={sessionContext.persona_id} onInsert={(value) => { setText((old) => old ? old + '\n' + value : value); setShowPhrases(false); window.setTimeout(() => composeInput.current?.focus(), 0); }} /></Dialog>}
    {rememberingMessage && <RememberMessageDialog message={rememberingMessage} personaId={sessionContext?.persona_id} onClose={() => setRememberingMessage(null)} onSaved={() => { setRememberingMessage(null); setNotice('记忆已保存，可在对应人格的记忆工作区查看。'); }} />}
    {showOptions && selected && <ChatOptionsDialog value={chatSelection} onClose={() => setShowOptions(false)} onApply={(value) => { setSelections((old) => ({ ...old, [selected.id]: value })); setShowOptions(false); }} />}
    {managingMessage && <MessageActionsDialog message={managingMessage} canRetry={managingMessage.status === 'error' && !![...messages].reverse().find((item) => item.role === 'user')?.checkpointId} latest={messages.indexOf(managingMessage) >= messages.length - 1 - [...messages].reverse().findIndex((item) => item.role === 'user')} busy={!!busy || streaming} onClose={() => setManagingMessage(null)} onAction={(action, value) => void messageAction(action, value)} />}
    {versionMessage && selected && <MessageVersionsDialog sessionId={selected.id} messageId={versionMessage.id} onClose={() => setVersionMessage(null)} onRestore={async () => { setMessages((await api.loadSession(selected.id)).messages); }} />}
    {exportingSession && <Dialog title="导出会话" onClose={() => { if (!busy) setExportingSession(null); }}><p className="dialog-description">正文导出包含消息和附件名称，附件文件需单独下载。</p><div className="session-menu"><button type="button" disabled={!!busy} onClick={() => void exportSession('md')}>导出 Markdown 文本</button><button type="button" disabled={!!busy} onClick={() => void exportSession('json')}>导出 JSON 记录</button></div><h3>备份对话</h3><p className="field-help">保存这个会话的模型上下文为 JSONL 文件，需要当前管理密钥具有 data 权限。文件不包含连接密钥或整站数据。</p><div className="dialog-actions"><button type="button" className="primary-button" disabled={!!busy} onClick={() => void exportSession('backup')}>{busy === 'export' ? '正在导出…' : '备份对话'}</button></div></Dialog>}
    {searchMessages && <MessageSearchDialog onClose={() => setSearchMessages(false)} onOpen={(match) => { setSearchMessages(false); void openSession(sessions.find((item) => item.id === match.session_id) || { id: match.session_id, title: match.session_title, updatedAt: match.created_at }, match.message_id); }} />}
    <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-label="拍照附件" onChange={(event) => void uploadFiles(event.target.files)} />
    <input ref={albumInput} type="file" accept="image/*" multiple hidden aria-label="相册附件" onChange={(event) => void uploadFiles(event.target.files)} />
    {attachmentPicker && <Dialog title="添加附件" onClose={() => setAttachmentPicker(false)}><div className="session-menu"><button type="button" onClick={() => { setAttachmentPicker(false); cameraInput.current?.click(); }}>拍照</button><button type="button" onClick={() => { setAttachmentPicker(false); albumInput.current?.click(); }}>从相册选择</button><button type="button" onClick={() => { setAttachmentPicker(false); fileInput.current?.click(); }}>选择文件、音频或视频</button></div><p className="field-help">大图片会先在本机压缩，再上传。</p></Dialog>}
    {managingSession && <Dialog title={managingSession.title || '会话操作'} onClose={() => { if (!busy) setManagingSession(null); }}><div className="session-menu">
      <button type="button" disabled={!!busy} onClick={() => void changeSessionMeta(managingSession, { pinned: !sessionMeta[managingSession.id]?.pinned })}>{sessionMeta[managingSession.id]?.pinned ? '取消置顶' : '置顶会话'}</button>
      <button type="button" disabled={!!busy} onClick={() => void changeSessionMeta(managingSession, { starred: !sessionMeta[managingSession.id]?.starred })}>{sessionMeta[managingSession.id]?.starred ? '取消星标' : '添加星标'}</button>
      <button type="button" disabled={!!busy} onClick={() => void changeSessionMeta(managingSession, { archived: !sessionMeta[managingSession.id]?.archived })}>{sessionMeta[managingSession.id]?.archived ? '取消归档' : '归档会话'}</button>
      <button type="button" disabled={!!busy} onClick={() => { setNewTitle(managingSession.title); setEditing({ session: managingSession, action: 'rename' }); setManagingSession(null); }}>重命名会话</button>
      <button type="button" disabled={!!busy} onClick={() => { setExportingSession(managingSession); setManagingSession(null); }}>导出会话</button>
      <button type="button" className="danger-text" disabled={!!busy} onClick={() => { setEditing({ session: managingSession, action: 'delete' }); setManagingSession(null); }}>删除会话</button>
    </div></Dialog>}
    {editing && <Dialog title={editing.action === 'rename' ? '重命名会话' : '删除这段会话？'} onClose={() => { if (!busy) setEditing(null); }}><form onSubmit={(event) => void editSession(event)}>{editing.action === 'rename' ? <label className="dialog-field">会话名称<input autoFocus value={newTitle} maxLength={100} required onChange={(event) => setNewTitle(event.target.value)} /></label> : <p className="dialog-description">「{editing.session.title || '未命名对话'}」及其中的消息将从当前核心删除，此操作无法撤销。</p>}<div className="dialog-actions"><button className="secondary-button" type="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button><button className={editing.action === 'delete' ? 'danger-button' : 'primary-button'} type="submit" disabled={!!busy || (editing.action === 'rename' && !newTitle.trim())}>{busy === 'edit' ? '正在保存…' : editing.action === 'delete' ? '删除会话' : '保存名称'}</button></div></form></Dialog>}
    {splash && <Splash onFinish={finishSplash} />}
  </div>;
}
