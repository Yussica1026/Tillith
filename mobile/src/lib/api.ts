import { Capacitor, registerPlugin } from '@capacitor/core';

export type Mode = 'cloud' | 'device';
export type Settings = { mode: Mode; serverUrl: string; apiKey: string };
export type Session = { id: string; title: string; updatedAt: string };
export type Attachment = { id: string; name: string; type: 'image' | 'record' | 'file' | 'video'; url?: string };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; attachments?: Attachment[]; status?: 'sending' | 'streaming' | 'done' | 'error' };
export type Connection = { mode: Mode; username: string; label: string };
export type CoreStatus = { available: boolean; running: boolean; message: string };
export type ChatSelection = { configId: string; providerId: string; model: string };
export type ChatOptions = { configs: { id: string; name: string }[]; providers: { id: string; name: string; model: string }[]; default_config_id: string };
export type StreamEvent = { type: 'text' | 'reasoning' | 'saved' | 'complete' | 'attachment' | 'error'; text?: string; attachment?: Attachment; messageId?: string };

const Core = registerPlugin<{
  status(): Promise<CoreStatus>;
  start(): Promise<CoreStatus>;
  connection(): Promise<{ baseUrl: string; apiKey: string }>;
}>('TillithCore');
const Vault = registerPlugin<{
  read(): Promise<{ value?: string }>;
  write(options: { value: string }): Promise<void>;
}>('TillithVault');

let current: { base: string; key: string; username: string } | undefined;
let cloudKey = '';
const sockets = new Set<WebSocket>();
const unavailable = '手机内置核心需要在包含 Python 核心的安卓安装包中启动。';

export async function loadSettings(): Promise<Settings> {
  let prefs: Partial<Settings> = {};
  try { prefs = JSON.parse(localStorage.getItem('tillith.preferences') || '{}'); } catch { /* Invalid settings are ignored. */ }
  if (Capacitor.isNativePlatform()) {
    try { cloudKey = (await Vault.read()).value || ''; } catch { cloudKey = ''; }
  }
  return { mode: prefs.mode === 'device' ? 'device' : 'cloud', serverUrl: typeof prefs.serverUrl === 'string' ? prefs.serverUrl : '', apiKey: cloudKey };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (Capacitor.isNativePlatform()) await Vault.write({ value: settings.apiKey });
  cloudKey = settings.apiKey;
  localStorage.setItem('tillith.preferences', JSON.stringify({ mode: settings.mode, serverUrl: settings.serverUrl }));
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

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const connection = requireConnection();
  const headers = new Headers(init.headers);
  headers.set('X-API-Key', connection.key);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(connection.base + '/api/v1' + path, { ...init, headers, credentials: 'omit', signal: init.signal || AbortSignal.timeout(20000) });
  } catch { throw new Error('连接中断，请检查服务器地址和网络。'); }
  if (response.status === 401 || response.status === 403) throw new Error('连接凭据无效或权限不足，请检查聊天密钥。');
  if (!response.ok) throw new Error('Tillith 暂时无法完成请求，请稍后重试。');
  let envelope;
  try { envelope = await response.json(); } catch { throw new Error('服务器响应格式不正确，请确认连接的是 Tillith 核心。'); }
  if (envelope.status !== 'ok') throw new Error('操作未完成，请检查会话是否仍存在及账号权限。');
  return envelope.data;
}

export function disconnect(): void {
  for (const ws of sockets) ws.close();
  sockets.clear();
  current = undefined;
}

export async function connect(settings: Settings): Promise<Connection> {
  disconnect();
  let base: string, key: string;
  if (settings.mode === 'device') {
    const state = await deviceStatus();
    if (!state.running) throw new Error(state.message);
    const local = await Core.connection();
    base = baseUrl(local.baseUrl); key = local.apiKey;
  } else {
    base = baseUrl(settings.serverUrl); key = settings.apiKey.trim();
    if (!key) throw new Error('请填写 Tillith 的聊天 API Key。');
  }
  current = { base, key, username: '' };
  try {
    const profile = await request('/tillith/profile');
    if (profile.app !== 'Tillith' || typeof profile.username !== 'string') throw new Error('该服务尚未包含 Tillith 的身份接口，请更新核心。');
    current.username = profile.username;
    return { mode: settings.mode, username: profile.username, label: settings.mode === 'device' ? '手机内置核心' : '云端核心' };
  } catch (error) { current = undefined; throw error; }
}

function session(row: any): Session {
  return { id: String(row.session_id), title: row.display_name || '新的对话', updatedAt: row.updated_at || row.created_at || '' };
}

export async function listSessions(): Promise<Session[]> {
  const username = requireConnection().username;
  const data = await request('/chat/sessions?' + new URLSearchParams({ username, platform_id: 'webchat', page: '1', page_size: '100' }));
  return (data.sessions || []).map(session);
}

export async function createSession(): Promise<Session> { return session(await request('/chat/sessions/new?platform_id=webchat')); }
export async function listChatOptions(configId?: string): Promise<ChatOptions> {
  return request('/tillith/chat-options' + (configId ? '?' + new URLSearchParams({ config_id: configId }) : ''));
}
export async function renameSession(id: string, title: string): Promise<void> { await request('/chat/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ display_name: title }) }); }
export async function deleteSession(id: string): Promise<void> { await request('/chat/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); }

export async function loadMessages(id: string): Promise<Message[]> {
  const data = await request('/chat/sessions/' + encodeURIComponent(id) + '?page=1&page_size=1000');
  return (data.history || []).map((row: any): Message => {
    const role = row.sender_id === 'bot' || row.sender_name === 'bot' || row.type === 'bot' ? 'assistant' : 'user';
    let content: any;
    try { content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content || {}; }
    catch { return { id: String(row.id), role, text: '这条消息无法读取', status: 'error' }; }
    const parts = Array.isArray(content?.message) ? content.message : [];
    return {
      id: String(row.id), role,
      text: parts.filter((p: any) => p.type === 'plain').map((p: any) => p.text || '').join(''),
      reasoning: parts.filter((p: any) => p.type === 'think' || p.type === 'reasoning').map((p: any) => p.type === 'think' ? p.think || '' : p.text || '').join('') || (typeof content?.reasoning === 'string' ? content.reasoning : ''),
      attachments: parts.filter((p: any) => p.attachment_id && ['image', 'record', 'file', 'video'].includes(p.type)).map((p: any) => ({ id: p.attachment_id, type: p.type, name: p.filename || p.name || '附件' })),
      status: 'done',
    };
  });
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
  const { base, key, username } = requireConnection();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const url = new URL(base + '/api/v1/chat/ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.add(ws);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      sockets.delete(ws); ws.close();
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(() => finish(new Error('本轮等待超时，请重新打开会话查看是否已有回复。')), 10 * 60 * 1000);
    const cancel = () => {
      void request('/chat/sessions/' + encodeURIComponent(id) + '/stop', { method: 'POST' }).catch(() => {});
      finish(new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', api_key: key }));
    const sendChat = () => ws.send(JSON.stringify({ t: 'send', username, session_id: id, message_id: crypto.randomUUID(),
      ...(selection?.configId ? { config_id: selection.configId } : {}),
      ...(selection?.providerId ? { selected_provider: selection.providerId, selected_model: selection.model } : {}),
      message: [{ type: 'plain', text }, ...attachments.map(a => ({ type: a.type, attachment_id: a.id, filename: a.name }))],
      flags: { enable_streaming: true, enable_reasoning: true, enable_inline_genui: false, enable_default_system_prompt: true },
    }));
    ws.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { finish(new Error('收到无法解析的回复。')); return; }
      if (event.type === 'auth_ok') {
        sendChat();
      } else if (event.type === 'plain' && !['tool_call', 'tool_call_result', 'agent_stats'].includes(event.chain_type)) {
        onEvent({ type: event.chain_type === 'reasoning' ? 'reasoning' : 'text', text: String(event.data || '') });
      } else if (event.type === 'message_saved') {
        onEvent({ type: 'saved', messageId: String(event.data.id) });
      } else if (event.type === 'end') {
        onEvent({ type: 'complete' }); finish();
      } else if (event.type === 'error') {
        const error = event.code === 'UNAUTHORIZED' ? '聊天凭据失效，请重新连接。' : '核心未能完成回复，请检查模型配置和运行状态。';
        onEvent({ type: 'error', text: error }); finish(new Error(error));
      }
    };
    ws.onerror = () => finish(new Error('聊天连接失败，请检查网络后重试。'));
    ws.onclose = () => { if (!finished) finish(new Error('连接已断开。本轮未自动重发，重新打开会话可查看已保存的回复。')); };
  });
}
