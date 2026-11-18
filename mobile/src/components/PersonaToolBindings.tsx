import { useEffect, useRef, useState } from 'react';
import { safeError } from '../lib/api';
import { loadToolsWorkspace } from '../lib/tools-api';

type Props = { value: string[] | null; disabled: boolean; onChange: (value: string[] | null) => void };
type Choice = { id: string; label: string };

export function PersonaToolBindings({ value, disabled, onChange }: Props) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadToolsWorkspace>>>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const previousSelection = useRef<string[]>([]);
  const custom = value !== null;

  useEffect(() => {
    if (!custom) return;
    let active = true;
    setCatalog(undefined);
    setError('');
    void loadToolsWorkspace()
      .then(result => { if (active) setCatalog(result); })
      .catch(reason => { if (active) setError(safeError(reason)); });
    return () => { active = false; };
  }, [custom, revision]);

  const services: Choice[] = [], individual: Choice[] = [];
  const remoteServers = new Map(catalog?.servers.filter(server =>
    !server.readonly && (server.transport === 'sse' || server.transport === 'streamable_http')
  ).map(server => [server.name, server]));
  if (catalog?.personaToolBindings) {
    for (const server of remoteServers.values()) {
      const status = !server.active ? ' · 已停用' : !server.connected ? ' · 未连接' : '';
      services.push({ id: 'mcp:' + server.name, label: server.name + status });
    }
  }
  for (const tool of catalog?.tools || []) {
    if (tool.readonly || tool.origin === 'builtin') continue;
    let id = tool.name, label = tool.name;
    if (tool.origin === 'mcp') {
      if (!remoteServers.has(tool.origin_name)) continue;
      label += ' · ' + tool.origin_name;
      if (catalog?.personaToolBindings) {
        id = 'mcp-tool:' + encodeURIComponent(tool.origin_name) + '/' + encodeURIComponent(tool.name);
      }
    }
    individual.push({ id, label: label + (tool.active ? '' : ' · 已停用') });
  }
  const known = new Set([...services, ...individual].map(choice => choice.id));
  const retained = [...new Set(value)].filter(id => !known.has(id)).map(id => ({ id, label: id }));

  function choices(title: string, items: Choice[]) {
    if (!items.length) return null;
    return <fieldset className="persona-binding-options"><legend>{title}</legend>
      {items.map(({ id, label }) => <label className="toggle-field" key={id}>
        <input type="checkbox" checked={value?.includes(id) ?? false} onChange={event => {
          onChange(event.target.checked ? [...(value || []), id] : (value || []).filter(item => item !== id));
        }} />
        <span>{safeError(label)}</span>
      </label>)}
    </fieldset>;
  }

  return <fieldset className="context-fieldset" disabled={disabled}><legend>工具与 MCP</legend>
    <label className="dialog-field">可用工具范围<select value={custom ? 'custom' : 'inherit'} onChange={event => {
      if (event.target.value === 'custom') onChange(previousSelection.current);
      else { previousSelection.current = value || []; onChange(null); }
    }}>
      <option value="inherit">跟随核心默认</option><option value="custom">仅使用勾选项</option>
    </select></label>
    {custom && <>
      <p className="field-help">留空会禁用这个人格的可选工具。工具仍需在核心中启用。</p>
      {error && <div className="context-notice" role="alert">{error} <button className="text-button" type="button" onClick={() => setRevision(count => count + 1)}>重试读取目录</button></div>}
      {!error && !catalog && <p className="field-help" role="status">正在读取工具目录…</p>}
      {!!services.length && <p className="field-help">勾选整个 MCP 服务后，它以后新增的工具也会随之可用。</p>}
      {choices('整个远程 MCP 服务', services)}
      {choices('单个工具', individual)}
      {choices('其他已保存的绑定', retained)}
      {catalog && !services.length && !individual.length && <p className="field-help">当前目录没有可添加的工具或远程服务。</p>}
    </>}
  </fieldset>;
}
