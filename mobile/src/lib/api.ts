import { Capacitor, registerPlugin } from '@capacitor/core';
import { loadProfiles, profileSettings, saveProfile, selectProfile } from './profiles';

export type Mode = 'cloud' | 'device';
export type Settings = { mode: Mode; serverUrl: string; apiKey: string; profileId?: string; managementKey?: string };
export type Session = { id: string; title: string; updatedAt: string };
export type Attachment = { id: string; name: string; type: 'image' | 'record' | 'file' | 'video'; url?: string };
export type Usage = { input?: number; output?: number; cached?: number };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; attachments?: Attachment[]; status?: 'sending' | 'streaming' | 'done' | 'error'; checkpointId?: string; saved?: boolean; usage?: Usage };
export type ActiveRun = { run_id: string; session_id?: string; checkpointId?: string; status?: string; message: Message };
export type ChatAction =
  | { type: 'send'; sessionId: string; text: string; attachments: Attachment[] }
  | { type: 'edit'; sessionId: string; messageId: string; content: { message: { type: string; text?: string; [key: string]: unknown }[]; [key: string]: unknown } }
  | { type: 'regenerate'; sessionId: string; messageId: string }
  | { type: 'resume'; sessionId: string; runId: string };
export type MessageVersions = { user_message_id: number; can_select: boolean; versions: { id: string; created_at: string; current: boolean; messages: Record<string, unknown>[] }[] };
export type Connection = { mode: Mode; username: string; label: string; storageId: string };
export type CoreStatus = { available: boolean; running: boolean; message: string; restartRequired?: boolean; state?: 'unavailable' | 'idle' | 'starting' | 'ready' | 'failed' | 'stopped' };
export type ChatSelection = { configId: string; providerId: string; model: string; streaming?: boolean };
export type SessionMeta = { session_id: string; creator: string; pinned: boolean; starred: boolean; archived: boolean; updated_at: string | null };
export type SearchMatch = { message_id: string; session_id: string; session_title: string; role: 'user' | 'assistant'; text: string; created_at: string };
export type ChatOptions = { configs: { id: string; name: string }[]; providers: { id: string; name: string; model: string }[]; default_config_id: string };
export type StreamEvent = { type: 'text' | 'reasoning' | 'saved' | 'user_saved' | 'complete' | 'attachment' | 'error' | 'snapshot' | 'usage' | 'run'; text?: string; attachment?: Attachment; messageId?: string; checkpointId?: string; message?: Message; usage?: Usage; runId?: string; code?: string };

const Core = registerPlugin<{
  status(): Promise<CoreStatus>;
  start(): Promise<CoreStatus>;
  connection(): Promise<{ baseUrl: string; apiKey: string; managementKey?: string }>;
}>('TillithCore');
let current: { base: string; key: string; username: string; managementKey?: string } | undefined;
const sockets = new Set<WebSocket>();
const activeStreams = new Set<() => void>();
const unavailable = '手机内置核心需要在包含 Python 核心的安卓安装包中启动。';

export async function loadSettings(): Promise<Settings> {
  const { activeProfileId } = await loadProfiles();
  return profileSettings(activeProfileId);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const { profiles, activeProfileId } = await loadProfiles();
  const profile = profiles.find(item => item.id === (settings.profileId || activeProfileId));
  if (!profile) throw new Error('服务器配置不存在，请重新选择。');
  await saveProfile({ ...profile, mode: settings.mode, serverUrl: settings.serverUrl }, { chatKey: settings.apiKey, managementKey: settings.managementKey });
  await selectProfile(profile.id);
}

export async function deviceStatus(): Promise<CoreStatus> {
  if (!Capacitor.isNativePlatform()) return { available: false, running: false, message: unavailable };
  try { return await Core.status(); } catch { return { available: false, running: false, message: unavailable }; }
}

export async function startDeviceCore(): Promise<CoreStatus> {
  if (!Capacitor.isNativePlatform()) return deviceStatus();
  try { return await Core.start(); } catch { return { available: false, running: false, message: '手机核心启动失败，请查看本机运行状态。' }; }
}

function baseUrl(value: string): string {
  if (!value.trim() && !Capacitor.isNativePlatform()) return window.location.origin;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTPS 服务器地址。'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('云端连接需要 HTTPS，本机调试地址可使用 HTTP。');
  }
  return url.href.replace(/\/+$/, '');
}

function requireConnection() {
  if (!current) throw new Error('请先在设置中连接 Tillith。');
  return current;
}

export function safeError(value: unknown): string {
  let text = typeof value === 'string' ? value : value instanceof Error ? value.message : '操作未完成，请稍后重试。';
  if (current?.key) text = text.split(current.key).join('[已隐藏]');
  if (current?.managementKey) text = text.split(current.managementKey).join('[已隐藏]');
  return text.replace(/https?:\/\/[^\s<>"']+/gi, '[服务地址]')
    .replace(/\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|authorization|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 260);
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const connection = requireConnection();
  const headers = new Headers(init.headers);
  headers.set('X-API-Key', connection.key);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(connection.base + '/api/v1' + path, { ...init, headers, credentials: 'omit', signal: init.signal || AbortSignal.timeout(20000) });
  } catch { throw new Error('连接中断，请检查服务器地址和网络。'); }
  if (current !== connection) throw new DOMException('Connection changed', 'AbortError');
  if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}：连接凭据无效或权限不足，请检查聊天密钥。`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`HTTP ${response.status}：${safeError(body?.message || body?.detail || '请求未完成，请稍后重试。')}`);
  }
  let envelope;
  try { envelope = await response.json(); } catch { throw new Error('服务器响应格式不正确，请确认连接的是 Tillith 核心。'); }
  if (current !== connection) throw new DOMException('Connection changed', 'AbortError');
  if (envelope.status !== 'ok') throw new Error(safeError(envelope.message || '操作未完成，请检查会话是否仍存在及账号权限。'));
  return envelope.data;
}

export { request as chatRequest };

async function managementFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const identity = requireConnection();
  if (!identity.managementKey) throw new Error('请先在当前服务器配置中填写管理密钥；聊天密钥不会用于管理操作。');
  const headers = new Headers(init.headers);
  headers.set('X-API-Key', identity.managementKey);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(identity.base + '/api/v1' + path, { ...init, headers, credentials: 'omit', signal: init.signal || AbortSignal.timeout(30000) });
  } catch { throw new Error('管理连接中断，请检查服务器地址和网络。'); }
  if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
  if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}：管理密钥无效或缺少此操作需要的权限，请检查当前服务器配置。`);
  if (!response.ok) {
    const envelope = await response.json().catch(() => null);
    throw new Error(`HTTP ${response.status}：${safeError(envelope?.message || '管理操作未完成，请稍后重试。')}`);
  }
  return response;
}

export async function managementRequest(path: string, init: RequestInit = {}): Promise<any> {
  const response = await managementFetch(path, init);
  const envelope = await response.json().catch(() => null);
  if (!envelope || envelope.status !== 'ok') throw new Error(safeError(envelope?.message || '管理操作未完成，请稍后重试。'));
  return envelope.data;
}

export async function exportConversationBackup(sessionId: string): Promise<{ blob: Blob; filename: string }> {
  const identity = requireConnection();
  const { session } = await request(`/chat/sessions/${encodeURIComponent(sessionId)}?page_size=1`);
  if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
  const umo = `${session.platform_id}:${session.is_group ? 'GroupMessage' : 'FriendMessage'}:${session.platform_id}!${session.creator}!${session.session_id}`;
  const conversations: { user_id: string; cid: string }[] = [];
  for (let page = 1; ; page++) {
    const result = await managementRequest('/conversations?' + new URLSearchParams({ umo, page: String(page), page_size: '100', include_history: 'false' }));
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    // The upstream UMO query is a substring filter, so require an exact match before export.
    for (const row of result.conversations || []) if (row.user_id === umo && typeof row.cid === 'string') conversations.push({ user_id: umo, cid: row.cid });
    if (page >= result.pagination.total_pages) break;
  }
  if (!conversations.length) throw new Error('这个会话还没有可备份的模型上下文；可先使用正文导出保存聊天记录。');
  const response = await managementFetch('/conversations/export', { method: 'POST', body: JSON.stringify({ conversations }) });
  if (!response.headers.get('Content-Disposition')?.toLowerCase().includes('attachment')) throw new Error('服务器没有返回会话备份文件，请检查会话和数据权限。');
  const blob = await response.blob();
  if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
  return { blob, filename: `Tillith-conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl` };
}

export function disconnect(): void {
  current = undefined;
  for (const close of activeStreams) close();
  activeStreams.clear();
  for (const ws of sockets) ws.close();
  sockets.clear();
}

export async function connect(settings: Settings): Promise<Connection> {
  disconnect();
  let base: string, key: string, managementKey = settings.managementKey?.trim();
  if (settings.mode === 'device') {
    const state = await deviceStatus();
    if (!state.running) throw new Error(state.message);
    const local = await Core.connection();
    base = baseUrl(local.baseUrl); key = local.apiKey;
    managementKey = local.managementKey || managementKey;
  } else {
    base = baseUrl(settings.serverUrl); key = settings.apiKey.trim();
    if (!key) throw new Error('请填写 Tillith 的聊天 API Key。');
  }
  const identity = { base, key, username: '', managementKey };
  current = identity;
  try {
    const profile = await request('/tillith/profile');
    if (profile.app !== 'Tillith' || typeof profile.username !== 'string') throw new Error('该服务尚未包含 Tillith 的身份接口，请更新核心。');
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    identity.username = profile.username;
    return { mode: settings.mode, username: profile.username, label: settings.mode === 'device' ? '手机内置核心' : '云端核心', storageId: JSON.stringify([settings.mode === 'device' ? 'device' : base, profile.username]) };
  } catch (error) { if (current === identity) current = undefined; throw error; }
}

function session(row: any): Session {
  return { id: String(row.session_id), title: row.display_name || '新的对话', updatedAt: row.updated_at || row.created_at || '' };
}

export async function listSessions(): Promise<Session[]> {
  const username = requireConnection().username;
  const rows: Session[] = [];
  for (let page = 1; ; page++) {
    const data = await request('/chat/sessions?' + new URLSearchParams({ username, platform_id: 'webchat', page: String(page), page_size: '100' }));
    rows.push(...(data.sessions || []).map(session));
    if ((data.sessions || []).length < 100 || rows.length >= data.total) break;
  }
  return [...new Map(rows.map((item) => [item.id, item])).values()];
}

export async function createSession(): Promise<Session> { return session(await request('/chat/sessions/new?platform_id=webchat')); }
export async function listSessionMeta(): Promise<SessionMeta[]> {
  const items: SessionMeta[] = [];
  for (let page = 1; ; page++) {
    const result = await request(`/tillith/session-meta?page_size=200&page=${page}`);
    items.push(...result.items);
    if (!result.has_more) return items;
  }
}
export async function updateSessionMeta(id: string, patch: Partial<Pick<SessionMeta, 'pinned' | 'starred' | 'archived'>>): Promise<SessionMeta> {
  return request('/tillith/session-meta', { method: 'PATCH', body: JSON.stringify({ session_id: id, ...patch }) });
}
export async function searchMessages(query: string, role?: string, page = 1): Promise<{ items: SearchMatch[]; has_more: boolean }> {
  return request('/tillith/search?' + new URLSearchParams({ q: query, ...(role ? { role } : {}), page: String(page), page_size: '20' }));
}
export async function listChatOptions(configId?: string): Promise<ChatOptions> {
  return request('/tillith/chat-options' + (configId ? '?' + new URLSearchParams({ config_id: configId }) : ''));
}
export async function renameSession(id: string, title: string): Promise<void> { await request('/chat/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ display_name: title }) }); }
export async function deleteSession(id: string): Promise<void> { await request('/chat/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); }

function usageFromStats(stats: any): Usage | undefined {
  const values = stats?.token_usage;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  // The core's empty usage accumulator is all zero when the provider omits usage.
  if (!values || ![values.input_other, values.input_cached, values.output].some((value) => valid(value) && value > 0)) return undefined;
  return {
    input: valid(values.input_other) && valid(values.input_cached) ? values.input_other + values.input_cached : undefined,
    output: valid(values.output) ? values.output : undefined,
    cached: valid(values.input_cached) ? values.input_cached : undefined,
  };
}

export function messageFromContent(value: unknown, id: string = crypto.randomUUID(), role?: Message['role']): Message {
  let content: any = value;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return { id, role: role || 'assistant', text: '这条消息无法读取', status: 'error', saved: false }; }
  }
  if (!content || typeof content !== 'object') content = {};
  const parts = Array.isArray(content.message) ? content.message.filter((part: any) => part && typeof part === 'object') : [];
  return {
    id, role: role || (content.type === 'user' ? 'user' : 'assistant'),
    text: parts.filter((part: any) => part.type === 'plain' && typeof part.text === 'string').map((part: any) => part.text).join(''),
    reasoning: parts.filter((part: any) => part.type === 'think' || part.type === 'reasoning').map((part: any) => {
      const text = part.type === 'think' ? part.think : part.text;
      return typeof text === 'string' ? text : '';
    }).join('') || (typeof content.reasoning === 'string' ? content.reasoning : ''),
    attachments: parts.filter((part: any) => part.attachment_id && ['image', 'record', 'file', 'video'].includes(part.type)).map((part: any) => ({ id: String(part.attachment_id), type: part.type, name: part.filename || part.name || '附件' })),
    usage: usageFromStats(content.agent_stats), status: 'done', saved: false,
  };
}

export async function loadSession(id: string, targetMessageId?: string): Promise<{ messages: Message[]; activeRuns: ActiveRun[]; hasMore: boolean }> {
  const identity = requireConnection();
  let messages: Message[] = [];
  let activeRuns: ActiveRun[] = [];
  let hasMore = false;
  for (let page = 1; ; page++) {
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    const data = await request(`/chat/sessions/${encodeURIComponent(id)}?page=${page}&page_size=1000`);
    hasMore = Boolean(data.has_more);
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    const rows = (data.history || []).map((row: any): Message => ({
      ...messageFromContent(row.content, String(row.id), row.sender_id === 'bot' || row.sender_name === 'bot' ? 'assistant' : 'user'),
      checkpointId: typeof row.llm_checkpoint_id === 'string' ? row.llm_checkpoint_id : undefined,
      saved: true,
    }));
    messages = [...rows, ...messages];
    if (page === 1) activeRuns = (data.active_runs || []).filter((run: any) => typeof run.run_id === 'string').map((run: any): ActiveRun => ({
      run_id: run.run_id, session_id: run.session_id, checkpointId: run.llm_checkpoint_id, status: run.status,
      message: { ...messageFromContent(run.content, `run-${run.run_id}`, 'assistant'), checkpointId: run.llm_checkpoint_id, status: 'streaming', saved: false },
    }));
    if (!targetMessageId || messages.some((message) => message.id === targetMessageId) || !data.has_more || !rows.length) break;
  }
  return { messages: [...new Map(messages.map((message) => [message.id, message])).values()], activeRuns, hasMore };
}

export async function loadMessages(id: string): Promise<Message[]> {
  const identity = requireConnection();
  let messages: Message[] = [];
  for (let page = 1; ; page++) {
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    const data = await request(`/chat/sessions/${encodeURIComponent(id)}?page=${page}&page_size=1000`);
    if (current !== identity) throw new DOMException('Connection changed', 'AbortError');
    const rows = (data.history || []).map((row: any): Message => ({
      ...messageFromContent(row.content, String(row.id), row.sender_id === 'bot' || row.sender_name === 'bot' ? 'assistant' : 'user'),
      checkpointId: typeof row.llm_checkpoint_id === 'string' ? row.llm_checkpoint_id : undefined, saved: true,
    }));
    messages = [...rows, ...messages];
    if (!data.has_more || !rows.length) break;
  }
  return [...new Map(messages.map((message) => [message.id, message])).values()];
}

export async function listVersions(sessionId: string, messageId: string | number): Promise<MessageVersions> {
  return request(`/tillith/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/versions`);
}
export async function restoreVersion(sessionId: string, messageId: string | number, versionId: string): Promise<{ user_message_id: number; version_id: string }> {
  return request(`/tillith/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/version`, { method: 'POST', body: JSON.stringify({ version_id: versionId }) });
}
export async function deleteArchivedVersion(sessionId: string, messageId: string | number, versionId: string): Promise<{ deleted_version_id: string }> {
  return request(`/tillith/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/versions/${encodeURIComponent(versionId)}`, { method: 'DELETE' });
}
export async function deleteTurn(sessionId: string, messageId: string | number): Promise<{ deleted_message_ids: number[] }> {
  return request(`/tillith/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/turn`, { method: 'DELETE' });
}
export async function branchSession(sessionId: string, messageId: string | number): Promise<{ session_id: string; context_mode: string }> {
  return request(`/tillith/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/branch`, { method: 'POST' });
}

export async function uploadAttachment(file: File): Promise<Attachment> {
  if (file.size > 512 * 1024 * 1024) throw new Error('单个附件不能超过 512 MB。');
  const body = new FormData(); body.append('file', file);
  const row = await request('/file', { method: 'POST', body, signal: AbortSignal.timeout(180000) });
  return { id: row.attachment_id, name: row.filename, type: row.type };
}

export async function attachmentUrl(attachment: Attachment): Promise<string> {
  const { base, key } = requireConnection();
  const response = await fetch(base + '/api/v1/file?attachment_id=' + encodeURIComponent(attachment.id), { headers: { 'X-API-Key': key }, credentials: 'omit', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('附件无法读取，请检查权限或重新上传。');
  // FileResponse may contain JSON itself, including a document shaped like an
  // API error. File headers take precedence over examining its contents.
  const fileResponse = response.headers.has('content-disposition') ||
    (response.headers.has('etag') && response.headers.has('last-modified'));
  if (!fileResponse && (response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    const body = await response.clone().json().catch(() => null);
    if (body && typeof body === 'object' && !Array.isArray(body) && body.status === 'error') {
      throw new Error('附件无法读取，请检查权限或重新上传。');
    }
  }
  return URL.createObjectURL(await response.blob());
}

export async function sendMessage(id: string, text: string, attachments: Attachment[], onEvent: (event: StreamEvent) => void, signal?: AbortSignal, selection?: ChatSelection): Promise<void> {
  return streamChat({ type: 'send', sessionId: id, text, attachments }, onEvent, signal, selection);
}

export async function streamChat(action: ChatAction, onEvent: (event: StreamEvent) => void, signal?: AbortSignal, selection?: ChatSelection): Promise<void> {
  const identity = requireConnection();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const url = new URL(identity.base + '/api/v1/tillith/chat/ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let cancelling = false;
    let ws: WebSocket | undefined;
    let runId = action.type === 'resume' ? action.runId : undefined;
    let retries = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(retryTimer);
      signal?.removeEventListener('abort', cancel);
      activeStreams.delete(identityChanged);
      if (ws) { sockets.delete(ws); ws.close(); }
      error ? reject(error) : resolve();
    };
    const identityChanged = () => finish(new DOMException('Connection changed', 'AbortError'));
    const cancel = () => {
      if (finished || cancelling) return;
      if (current !== identity) { identityChanged(); return; }
      cancelling = true;
      clearTimeout(timeout); clearTimeout(retryTimer);
      // The stop endpoint acknowledges a request, not a durable final reply.
      // Wait for the stream end (sent after flush) before letting the UI reload.
      void request('/chat/sessions/' + encodeURIComponent(action.sessionId) + '/stop', { method: 'POST', signal: AbortSignal.timeout(10000) })
        .then(async () => {
          for (let attempt = 0; attempt < 40 && !finished; attempt++) {
            await new Promise((done) => setTimeout(done, 250));
            if (finished) return;
            if (current !== identity) { identityChanged(); return; }
            if (ws?.readyState !== WebSocket.OPEN || attempt === 39) {
              const state = await loadSession(action.sessionId);
              if (!state.activeRuns.length) { finish(new DOMException('Cancelled', 'AbortError')); return; }
            }
          }
          if (!finished) finish(new Error('已发送停止请求，但回复尚未确认结束，请重新打开会话检查。'));
        })
        .catch(() => finish(new Error('停止请求未确认，请重新打开会话检查运行状态。')));
    };
    activeStreams.add(identityChanged);
    signal?.addEventListener('abort', cancel, { once: true });
    const open = (resume: boolean) => {
      if (finished || cancelling) return;
      if (current !== identity) { identityChanged(); return; }
      const socket = new WebSocket(url);
      ws = socket;
      sockets.add(socket);
      let recovering = false;
      const recover = () => {
        if (finished || recovering || socket !== ws || cancelling) return;
        recovering = true;
        clearTimeout(timeout);
        sockets.delete(socket); socket.close();
        if (current !== identity) { identityChanged(); return; }
        if (!runId || retries >= 3) {
          finish(new Error(runId ? '连接暂时无法恢复，请重新打开会话查看已保存的回复。' : '连接已断开，请重新打开会话查看运行状态。本轮未重复发送。'));
          return;
        }
        retryTimer = setTimeout(() => open(true), 500 * 2 ** retries++);
      };
      timeout = setTimeout(recover, 15000);
      const sendCommand = () => {
        if (finished || cancelling || current !== identity) { socket.close(); return; }
        if (resume) {
          socket.send(JSON.stringify({ t: 'resume', run_id: runId }));
          return;
        }
        const command: Record<string, unknown> = {
          t: action.type, session_id: action.sessionId,
          ...(selection?.configId ? { config_id: selection.configId } : {}),
          ...(selection?.providerId ? { selected_provider: selection.providerId, selected_model: selection.model } : {}),
          flags: { enable_streaming: selection?.streaming !== false, enable_reasoning: true, enable_inline_genui: false, enable_default_system_prompt: true },
        };
        if (action.type === 'send') command.message = [{ type: 'plain', text: action.text }, ...action.attachments.map(attachment => ({ type: attachment.type, attachment_id: attachment.id, filename: attachment.name }))];
        if (action.type === 'edit' || action.type === 'regenerate') command.message_id = action.messageId;
        if (action.type === 'edit') command.content = action.content;
        socket.send(JSON.stringify(command));
      };
      socket.onopen = () => {
        if (finished || cancelling || current !== identity) { socket.close(); return; }
        socket.send(JSON.stringify({ t: 'auth', api_key: identity.key }));
      };
      socket.onmessage = (message) => {
        if (finished || recovering || socket !== ws || current !== identity) return;
        clearTimeout(timeout);
        if (!cancelling) timeout = setTimeout(recover, 45000);
        let event;
        try { event = JSON.parse(message.data); } catch { finish(new Error('收到无法解析的回复，请重新打开会话查看历史。')); return; }
        if (event.type === 'auth_ok') {
          sendCommand();
        } else if (event.type === 'run_started' && typeof event.data?.run_id === 'string') {
          runId = event.data.run_id;
          onEvent({ type: 'run', runId });
        } else if (event.type === 'run_snapshot' && event.data?.content) {
          runId = event.data.run_id || runId;
          onEvent({ type: 'run', runId });
          onEvent({ type: 'snapshot', message: { ...messageFromContent(event.data.content, `run-${runId}`, 'assistant'), checkpointId: event.data.llm_checkpoint_id, status: 'streaming', saved: false } });
        } else if (event.type === 'plain' && !['tool_call', 'tool_call_result', 'agent_stats'].includes(event.chain_type)) {
          onEvent({ type: event.chain_type === 'reasoning' ? 'reasoning' : 'text', text: typeof event.data === 'string' ? event.data : '' });
        } else if (event.type === 'agent_stats') {
          onEvent({ type: 'usage', usage: usageFromStats(event.data) });
        } else if ((event.type === 'message_saved' || event.type === 'user_message_saved') && event.data?.id != null) {
          onEvent({ type: event.type === 'user_message_saved' ? 'user_saved' : 'saved', messageId: String(event.data.id), checkpointId: event.data.llm_checkpoint_id });
        } else if (event.type === 'attachment_saved' && event.data?.id && ['image', 'record', 'file', 'video'].includes(event.data.type)) {
          onEvent({ type: 'attachment', attachment: { id: String(event.data.id), type: event.data.type, name: '附件' } });
        } else if (event.type === 'end') {
          if (cancelling) finish(new DOMException('Cancelled', 'AbortError'));
          else { onEvent({ type: 'complete' }); finish(); }
        } else if (event.type === 'error') {
          const code = typeof event.code === 'string' ? event.code : 'CHAT_ERROR';
          const detail = code === 'RUN_UNAVAILABLE' ? '本轮运行已结束或核心已重启，请重新打开会话读取已保存的回复。'
            : code === 'UNAUTHORIZED' ? '聊天凭据失效，请重新连接。'
            : event.data || '核心未能完成回复，请检查模型配置和运行状态。';
          const error = `${safeError(code)}：${safeError(detail)}`;
          onEvent({ type: 'error', text: error, code });
          finish(new Error(error));
        }
      };
      socket.onerror = recover;
      socket.onclose = recover;
    };
    open(action.type === 'resume');
  });
}
