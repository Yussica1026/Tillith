import { useEffect, useRef, useState, type FormEvent } from 'react';
import { safeError } from '../lib/api';
import * as toolsApi from '../lib/tools-api';
import type { McpDraft, McpServer } from '../lib/tools-api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

type HeaderRow = { id: number; name: string; value: string };

export function McpServerDialog({ server, existingNames, onClose, onSaved, onChanged }: { server?: McpServer; existingNames: string[]; onClose: () => void; onSaved: (server: McpServer) => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(server?.name || '');
  const [url, setUrl] = useState(server?.url_secret ? '' : server?.url || '');
  const [transport, setTransport] = useState<McpDraft['transport']>(server?.transport === 'sse' ? 'sse' : 'streamable_http');
  const [enabled, setEnabled] = useState(server?.active ?? true);
  const [headers, setHeaders] = useState<HeaderRow[]>([{ id: 0, name: '', value: '' }]);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [checkedTools, setCheckedTools] = useState<string[]>();
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(true);
  const nextHeaderId = useRef(1);
  const busy = pending !== null;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  function buildDraft(): McpDraft | undefined {
    setError('');
    if (!form.current?.reportValidity()) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('请填写服务名称。'); return; }
    if (trimmedName !== server?.name && existingNames.includes(trimmedName)) { setError('这个服务名称已存在，请换一个名称。'); return; }
    const address = url.trim();
    if (address) {
      let parsed: URL;
      try { parsed = new URL(address); } catch { setError('请填写完整的 HTTP 或 HTTPS 服务地址。'); return; }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) { setError('服务地址只支持 HTTP 或 HTTPS；认证信息请放在请求头中，地址不要带片段。'); return; }
    } else if (!server) { setError('请填写远程服务地址。'); return; }
    const values: Record<string, string> = {};
    const names = new Set<string>();
    for (const [index, row] of (clearHeaders ? [] : headers).entries()) {
      const key = row.name.trim();
      if (!key && !row.value) continue;
      if (!key || !row.value) { setError(`请补全第 ${index + 1} 行请求头，或移除这一行。`); return; }
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(row.value)) { setError(`第 ${index + 1} 行请求头格式不正确，名称和值不能包含换行。`); return; }
      if (names.has(key.toLowerCase())) { setError('请求头名称不能重复。'); return; }
      names.add(key.toLowerCase());
      values[key] = row.value;
    }
    return { name: trimmedName, url: address, transport, headers: values, clear_headers: clearHeaders, active: enabled };
  }

  async function test() {
    if (busy) return;
    const draft = buildDraft();
    if (!draft) return;
    setPending('test'); setCheckedTools(undefined);
    try {
      const result = await toolsApi.testMcpServer(draft, server?.name);
      if (active.current) setCheckedTools(result.tools);
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const draft = buildDraft();
    if (!draft) return;
    setPending('save');
    try {
      const saved = await toolsApi.saveMcpServer(draft, server?.name);
      if (active.current) onSaved(saved);
    } catch (reason) {
      if (active.current) {
        setError(safeError(reason));
        await onChanged();
      }
    } finally {
      if (active.current) setPending(null);
    }
  }

  return <Dialog title={server ? '编辑远程 MCP 服务' : '添加远程 MCP 服务'} onClose={() => { if (!busy) onClose(); }}>
    <form ref={form} className="mcp-form" onSubmit={event => void save(event)} onChange={() => setCheckedTools(undefined)}>
      {error && <p className="message-error mcp-form-error" role="alert">{error}</p>}
      <label className="dialog-field">服务名称<input aria-label="MCP 服务名称" required maxLength={200} autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：资料检索" /></label>
      <label className="dialog-field">服务地址<input aria-label="MCP 服务地址" type={server?.url_secret ? 'password' : 'url'} inputMode="url" required={!server} autoComplete="off" spellCheck={false} value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder={server?.url_secret ? '地址已保存，留空保留' : 'https://example.com/mcp'} /></label>
      {server?.url_secret && <p className="tools-help">原地址含私密参数，不会回显。需要更换时填写完整地址。</p>}
      {server && <p className="tools-help">更换地址的协议、域名或端口后，请重新填写认证请求头。</p>}
      <label className="dialog-field">连接方式<select aria-label="MCP 连接方式" value={transport} disabled={busy} onChange={event => setTransport(event.target.value as McpDraft['transport'])}><option value="streamable_http">HTTP（Streamable HTTP）</option><option value="sse">SSE</option></select></label>
      {server && <label className="toggle-field"><input type="checkbox" checked={clearHeaders} disabled={busy} onChange={event => setClearHeaders(event.target.checked)} />清除请求头</label>}
      <fieldset className="mcp-headers" disabled={busy || clearHeaders}><legend>认证与请求头</legend><p className="tools-help">{clearHeaders ? '保存时删除全部请求头；检查连接时也不发送已有请求头。' : server?.headers_present ? '同源地址下全部留空会沿用已有请求头；填写新的请求头会整体替换。' : '服务需要认证时再填写，例如 Authorization 与 Bearer 令牌。'}</p>
        {headers.map((row, index) => <div className="mcp-header-row" key={row.id}><label className="dialog-field">名称<input aria-label={`请求头名称 ${index + 1}`} autoComplete="off" spellCheck={false} value={row.name} onChange={event => setHeaders(current => current.map(item => item.id === row.id ? { ...item, name: event.target.value } : item))} placeholder="Authorization" /></label><label className="dialog-field">值<input aria-label={`请求头值 ${index + 1}`} type="password" autoComplete="new-password" spellCheck={false} value={row.value} onChange={event => setHeaders(current => current.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))} placeholder="只写入，不回显" /></label><button type="button" className="icon-button" aria-label={`移除请求头 ${index + 1}`} onClick={() => { setHeaders(current => current.filter(item => item.id !== row.id)); setCheckedTools(undefined); }}><Icon name="close" size={17} /></button></div>)}
        <button type="button" className="text-button" disabled={headers.length >= 32} onClick={() => { setHeaders(current => [...current, { id: nextHeaderId.current++, name: '', value: '' }]); setCheckedTools(undefined); }}><Icon name="plus" size={15} />添加请求头</button>
      </fieldset>
      <label className="toggle-field"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />保存后启用服务</label>
      {checkedTools && <section className="mcp-check-result" role="status"><strong>连接检查通过</strong><p>发现 {checkedTools.length} 个工具，配置尚未保存。</p>{checkedTools.length > 0 && <ul className="mcp-form-tools">{checkedTools.map(tool => <li key={tool}>{tool}</li>)}</ul>}</section>}
      <div className="mcp-form-test"><button type="button" className="secondary-button" disabled={busy} onClick={() => void test()}>{pending === 'test' ? <><Icon name="loader" size={16} className="spin" />正在检查连接…</> : '检查连接'}</button></div>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{pending === 'save' ? '正在保存…' : '保存服务'}</button></div>
    </form>
  </Dialog>;
}
