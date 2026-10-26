import { useEffect, useRef, useState } from 'react';
import { safeError } from '../lib/api';
import * as toolsApi from '../lib/tools-api';
import type { McpServer, ToolInfo } from '../lib/tools-api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { McpServerDialog } from './McpServerDialog';
import './tools.css';

type Workspace = Awaited<ReturnType<typeof toolsApi.loadToolsWorkspace>>;
type ToolFilter = 'all' | ToolInfo['origin'];
type ConnectionCheck = { tools: string[]; checkedAt: string };

const originLabels: Record<ToolInfo['origin'], string> = { builtin: '内置工具', mcp: 'MCP', plugin: '插件', unknown: '其他' };
const transportLabels: Record<McpServer['transport'], string> = { streamable_http: 'HTTP', sse: 'SSE', stdio: '本地进程', unsupported: '其他连接' };

export function ToolsWorkspace({ onBack, onSettings }: { onBack: () => void; onSettings: () => void }) {
  const [tab, setTab] = useState<'tools' | 'servers'>('tools');
  const [data, setData] = useState<Workspace>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ToolFilter>('all');
  const [editing, setEditing] = useState<{ server?: McpServer }>();
  const [deleting, setDeleting] = useState<McpServer>();
  const [checks, setChecks] = useState<Record<string, ConnectionCheck>>({});
  const active = useRef(false);
  const revision = useRef(0);
  const busy = loading || pending !== null;

  async function refresh(clearError = true): Promise<void> {
    const request = ++revision.current;
    setLoading(true);
    if (clearError) setError('');
    try {
      const next = await toolsApi.loadToolsWorkspace();
      if (active.current && request === revision.current) setData(next);
    } catch (reason) {
      if (active.current && request === revision.current) setError(safeError(reason));
    } finally {
      if (active.current && request === revision.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; revision.current += 1; };
  }, []);

  async function change(label: string, action: () => Promise<unknown>, message: string): Promise<boolean> {
    if (busy) return false;
    setPending(label);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (!active.current) return false;
      setNotice(result && typeof result === 'object' && 'warning' in result && typeof result.warning === 'string' ? safeError(result.warning) : message);
      await refresh(false);
      return true;
    } catch (reason) {
      if (active.current) {
        const failure = safeError(reason);
        await refresh(false);
        if (active.current) setError(failure);
      }
      return false;
    } finally {
      if (active.current) setPending(null);
    }
  }

  async function checkServer(server: McpServer) {
    if (busy || server.readonly) return;
    setPending('test:' + server.name);
    setError('');
    setNotice('');
    setChecks(current => { const next = { ...current }; delete next[server.name]; return next; });
    try {
      const result = await toolsApi.testMcpServer({ name: server.name, url: server.url_secret ? '' : server.url, transport: server.transport === 'sse' ? 'sse' : 'streamable_http', headers: {}, active: server.active }, server.name);
      if (active.current) setChecks(current => ({ ...current, [server.name]: { tools: result.tools, checkedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } }));
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) setPending(null);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const visibleTools = (data?.tools || []).filter(tool => (filter === 'all' || tool.origin === filter) && (!needle || [tool.name, tool.description, tool.origin_name, tool.origin_display_name].some(value => value.toLocaleLowerCase().includes(needle))));
  const visibleServers = (data?.servers || []).filter(server => !needle || [server.name, server.url_secret ? '' : server.url, ...server.tools].some(value => value.toLocaleLowerCase().includes(needle)));

  return <main className="settings-page tools-workspace">
    <div className="page-heading tools-heading">
      <div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><span className="eyebrow">让对话多一些能力</span><h1>工具与 MCP</h1></div>
      <button type="button" className="icon-button" aria-label="刷新工具与服务" disabled={busy} onClick={() => { setNotice(''); void refresh(); }}><Icon name={loading ? 'loader' : 'refresh'} className={loading ? 'spin' : ''} /></button>
    </div>
    <p className="tools-intro">管理当前核心可用的工具，接入远程服务。这里的启停设置会影响使用这个核心的对话。</p>
    <nav className="tools-tabs" aria-label="工具工作区">
      <button type="button" aria-current={tab === 'tools' ? 'page' : undefined} onClick={() => { setTab('tools'); setQuery(''); }}>工具<span>{data?.tools.length ?? '—'}</span></button>
      <button type="button" aria-current={tab === 'servers' ? 'page' : undefined} onClick={() => { setTab('servers'); setQuery(''); }}>MCP 服务<span>{data?.servers.length ?? '—'}</span></button>
    </nav>
    {error && !deleting && <div className="tools-notice tools-notice--error" role="alert"><p>{error}</p><div className="tools-actions"><button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>重新读取</button><button type="button" className="text-button" onClick={onSettings}>检查管理密钥</button></div><small>此工作区需要管理密钥的 mcp 权限。</small></div>}
    {notice && <p className="tools-notice" role="status">{notice}</p>}
    {!data && loading && <p className="tools-empty" role="status"><Icon name="loader" className="spin" />正在读取工具与服务…</p>}
    {data && <>
      <div className="tools-toolbar">
        <label className="dialog-field tools-search">{tab === 'tools' ? '搜索工具' : '搜索服务'}<input type="search" aria-label={tab === 'tools' ? '搜索工具' : '搜索服务'} placeholder={tab === 'tools' ? '名称、说明或来源' : '服务名称或工具名称'} value={query} onChange={event => setQuery(event.target.value)} /></label>
        {tab === 'servers' && <button type="button" className="primary-button" disabled={busy} onClick={() => setEditing({})}><Icon name="plus" size={17} />添加服务</button>}
      </div>
      {tab === 'tools' ? <>
        <div className="tools-filters" aria-label="工具来源">{(['all', 'builtin', 'mcp', 'plugin', 'unknown'] as const).filter(origin => origin === 'all' || data.tools.some(tool => tool.origin === origin)).map(origin => <button type="button" key={origin} aria-pressed={filter === origin} onClick={() => setFilter(origin)}>{origin === 'all' ? '全部' : originLabels[origin]}</button>)}</div>
        <div className="tool-list">{visibleTools.map(tool => <article className="tool-row" key={tool.name}>
          <div className="tool-row-heading"><div><span className="tool-source">{originLabels[tool.origin]}{tool.origin_display_name || tool.origin_name ? ' · ' + (tool.origin_display_name || tool.origin_name) : ''}</span><h2>{tool.name}</h2></div><button type="button" role="switch" aria-checked={tool.active} aria-label={`允许 ${tool.name}`} className="tool-switch" disabled={busy || tool.readonly} onClick={() => void change('tool:' + tool.name, () => toolsApi.setToolEnabled(tool.name, !tool.active), `已${tool.active ? '禁用' : '允许'}工具「${tool.name}」。`)}><span aria-hidden="true" /></button></div>
          {tool.description && <p className="tool-description">{tool.description}</p>}
          <div className="tool-row-meta"><span>{pending === 'tool:' + tool.name ? '正在更新…' : tool.active ? '允许使用' : '已禁用'}</span>{tool.readonly && <small>由核心配置控制</small>}{tool.permission === 'admin' && <small>仅管理员可调用</small>}</div>
        </article>)}</div>
        {visibleTools.length === 0 && <div className="tools-empty"><Icon name="bolt" size={26} /><h2>{data.tools.length ? '没有匹配的工具' : '还没有可用工具'}</h2><p>{data.tools.length ? '换个关键词，或选择其他来源。' : '添加并启用一个远程 MCP 服务后，它提供的工具会出现在这里。'}</p>{!data.tools.length && <button type="button" className="text-button" onClick={() => { setTab('servers'); setQuery(''); }}>添加 MCP 服务<Icon name="chevron" size={15} /></button>}</div>}
      </> : <>
        <p className="tools-help">支持 HTTP 与 SSE 远程服务。先检查连接，再选择是否启用。</p>
        <div className="mcp-list">{visibleServers.map(server => {
          const check = checks[server.name];
          return <article className="mcp-card" key={server.name}>
            <div className="tool-row-heading"><div><span className="tool-source">{transportLabels[server.transport]}{server.readonly ? ' · 只读' : ''}</span><h2>{server.name}</h2></div><span className={`mcp-status ${server.active && server.connected ? 'mcp-status--connected' : ''}`}><i aria-hidden="true" />{!server.active ? '已停用' : server.connected ? '已连接' : '未连接'}</span></div>
            {!server.readonly && <p className="mcp-address">{server.url_secret ? '服务地址已保存（含私密参数）' : server.url || '未填写服务地址'}</p>}
            {server.headers_present && <p className="tools-help">已保存认证请求头</p>}
            {server.readonly && <p className="tools-help">此服务使用本地进程或暂不支持的连接方式，可在这里查看、停用或删除。</p>}
            {server.active && !server.connected && !server.readonly && <p className="mcp-disconnected">服务已启用但尚未连接。检查连接可查看当前是否能访问。</p>}
            <div className="tools-actions">
              {!server.readonly && <><button type="button" className="text-button" disabled={busy} onClick={() => setEditing({ server })}>编辑</button><button type="button" className="text-button" disabled={busy} onClick={() => void checkServer(server)}>{pending === 'test:' + server.name ? '正在检查…' : '检查连接'}</button></>}
              {(!server.readonly || server.active) && <button type="button" className="text-button" disabled={busy} onClick={() => void change('server:' + server.name, () => toolsApi.setMcpServerEnabled(server.name, !server.active), `已${server.active ? '停用' : '启用'}服务「${server.name}」。`)}>{pending === 'server:' + server.name ? '正在更新…' : server.active ? '停用' : '启用'}</button>}
              <button type="button" className="text-button danger-text" disabled={busy} onClick={() => { setError(''); setDeleting(server); }}>删除</button>
            </div>
            {server.tools.length > 0 && <details className="mcp-discovery"><summary>已连接服务的工具 <span>{server.tools.length}</span></summary><ul>{server.tools.map(name => <li key={name}>{name}</li>)}</ul></details>}
            {check && <section className="mcp-check-result" role="status"><strong>连接检查通过</strong><small>{check.checkedAt} · 发现 {check.tools.length} 个工具 · 未改变启用状态</small>{check.tools.length > 0 && <details className="mcp-discovery" open><summary>检查发现的工具</summary><ul>{check.tools.map(name => <li key={name}>{name}</li>)}</ul></details>}</section>}
          </article>;
        })}</div>
        {visibleServers.length === 0 && <div className="tools-empty"><Icon name="cloud" size={28} /><h2>{data.servers.length ? '没有匹配的服务' : '接入第一个远程服务'}</h2><p>{data.servers.length ? '试试搜索服务名称，或清空关键词。' : '填写服务地址和需要的认证请求头，检查连接后即可保存。'}</p>{!data.servers.length && <button type="button" className="text-button" disabled={busy} onClick={() => setEditing({})}>添加远程服务<Icon name="chevron" size={15} /></button>}</div>}
      </>}
    </>}
    {editing && <McpServerDialog server={editing.server} existingNames={data?.servers.map(server => server.name) || []} onClose={() => setEditing(undefined)} onSaved={server => { setEditing(undefined); setNotice(server.warning ? safeError(server.warning) : `服务「${server.name}」已保存。${server.active && !server.connected ? '服务尚未连接，请检查连接。' : ''}`); setChecks({}); void refresh(); }} onChanged={() => refresh(false)} />}
    {deleting && <Dialog title="删除 MCP 服务？" onClose={() => { if (!busy) setDeleting(undefined); }}><p className="dialog-description">删除「{deleting.name}」及其连接配置，已启用的服务也会断开。聊天记录仍会保留。</p>{error && <p className="message-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={async () => { const target = deleting; if (await change('delete:' + target.name, () => toolsApi.deleteMcpServer(target.name), `已删除服务「${target.name}」。`) && active.current) { setDeleting(undefined); setChecks(current => { const next = { ...current }; delete next[target.name]; return next; }); } }}>{pending === 'delete:' + deleting.name ? '正在删除…' : '确认删除'}</button></div></Dialog>}
  </main>;
}
