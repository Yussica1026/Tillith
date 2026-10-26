import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { safeError } from '../lib/api';
import { loadToolsWorkspace, saveMcpServer, type McpServer } from '../lib/tools-api';
import { buildMcpExport, MAX_MCP_IMPORT_BYTES, parseMcpImport, validateMcpImport, type McpImportItem } from '../lib/mcp-transfer';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

type ImportRow = McpImportItem & { selected: boolean; saved?: boolean; failure?: string; headersRemoved?: boolean };

export function McpTransferDialog({ mode, servers, onClose, onChanged, onExported }: { mode: 'import' | 'export'; servers: McpServer[]; onClose: () => void; onChanged: () => Promise<void>; onExported: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [selected, setSelected] = useState(() => new Set(servers.filter(server => !server.readonly).map(server => server.name)));
  const [pending, setPending] = useState<'read' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const active = useRef(true);
  const busy = pending !== null;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    setPending('read'); setError(''); setResult(''); setRows([]);
    try {
      if (file.size > MAX_MCP_IMPORT_BYTES) throw new Error('配置文件不能超过 1 MiB。');
      const items = parseMcpImport(await file.text());
      if (!items.length) throw new Error('配置文件中没有 MCP 服务。');
      if (active.current) setRows(items.map(item => ({ ...item, selected: !item.issue })));
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) setPending(null);
    }
  }

  const names = servers.map(server => server.name);
  const candidates = rows.filter(row => row.selected && !row.saved);
  const rowError = (row: ImportRow) => validateMcpImport(row, [...names, ...candidates.filter(other => other.id !== row.id).map(other => other.draft.name.trim())]);
  const canImport = candidates.length > 0 && candidates.every(row => !rowError(row));
  const exportedServers = servers.filter(server => !server.readonly && selected.has(server.name));

  async function importSelected() {
    if (busy || !canImport) return;
    setPending('save'); setError(''); setResult('');
    let saved = 0;
    let failed = 0;
    try {
      const current = await loadToolsWorkspace();
      const existing = current.servers.map(server => server.name);
      for (const row of candidates) {
        if (!active.current) break;
        try {
          const problem = validateMcpImport(row, existing);
          if (problem) throw new Error(problem);
          const created = await saveMcpServer({ ...row.draft, name: row.draft.name.trim(), active: false });
          if (created.active) throw new Error('服务状态与导入要求不一致，请刷新检查。');
          saved += 1;
          existing.push(created.name);
          if (active.current) setRows(currentRows => currentRows.map(item => item.id === row.id ? { ...item, selected: false, saved: true, failure: undefined, draft: { ...item.draft, headers: {} } } : item));
        } catch (reason) {
          failed += 1;
          if (active.current) setRows(currentRows => currentRows.map(item => item.id === row.id ? { ...item, failure: safeError(reason) } : item));
        }
      }
      if (active.current) setResult(`本次已导入 ${saved} 项，均保持停用。${failed ? `还有 ${failed} 项未完成，请查看各项提示和服务列表。` : '可关闭此窗口，逐项检查连接并启用。'}`);
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) { await onChanged(); if (active.current) setPending(null); }
    }
  }

  async function exportSelected() {
    if (busy || !exportedServers.length) return;
    setPending('save'); setError('');
    try {
      const text = JSON.stringify(buildMcpExport(exportedServers), null, 2);
      const name = 'Tillith-MCP.json';
      if (Capacitor.isNativePlatform()) {
        const files = registerPlugin<{ saveText(options: { name: string; text: string }): Promise<{ cancelled?: boolean }> }>('TillithFiles');
        if ((await files.saveText({ name, text })).cancelled) return;
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (active.current) onExported();
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) setPending(null);
    }
  }

  return <Dialog title={mode === 'import' ? '导入 MCP 配置' : '导出 MCP 配置'} onClose={() => { if (!busy) onClose(); }}>
    <div className="mcp-transfer">
      {error && <p className="message-error" role="alert">{error}</p>}
      {mode === 'import' ? <>
        <p className="dialog-description">选择含 mcpServers 的 JSON 文件，预览后导入。只添加远程服务，不覆盖已有同名配置。</p>
        <label className="dialog-field">选择配置文件<input type="file" accept=".json,application/json" disabled={busy} onChange={event => void readFile(event)} /></label>
        <p className="tools-help">最多 50 项、1 MiB。导入后全部停用，不会自动连接；文件中的认证请求头仅随选中的服务保存。</p>
        {result && <p className="tools-notice" role="status">{result}</p>}
        {rows.length > 0 && <p className="mcp-transfer-count">{rows.length} 项配置 · 已选 {candidates.length} 项</p>}
        <div className="mcp-transfer-list">{rows.map(row => {
          const problem = row.saved ? '' : rowError(row);
          return <section className="mcp-transfer-row" key={row.id}>
            <label className="toggle-field"><input type="checkbox" aria-label={`选择导入 ${row.draft.name}`} checked={row.selected} disabled={busy || row.saved || !!row.issue} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, selected: event.target.checked } : item))} /><span>{row.saved ? <><Icon name="check" size={15} />已导入 · </> : ''}{row.draft.name || '未命名服务'}</span></label>
            {!row.issue && !row.saved && <div className="mcp-transfer-fields">
              <label className="dialog-field">服务名称<input aria-label={`导入服务名称 ${row.id + 1}`} value={row.draft.name} maxLength={200} disabled={busy} onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, failure: undefined, draft: { ...item.draft, name: event.target.value } } : item))} /></label>
              <label className="dialog-field">服务地址<input aria-label={`导入服务地址 ${row.id + 1}`} type={/[?@#]/.test(row.draft.url) ? 'password' : 'url'} inputMode="url" autoComplete="off" spellCheck={false} value={row.draft.url} maxLength={8192} disabled={busy} placeholder="https://example.com/mcp" onChange={event => setRows(current => current.map(item => item.id === row.id ? { ...item, failure: undefined, headersRemoved: item.headersRemoved || Object.keys(item.draft.headers).length > 0, draft: { ...item.draft, url: event.target.value, headers: {} } } : item))} /></label>
            </div>}
            {!row.issue && !row.saved && <p className="tools-help">{row.draft.transport === 'sse' ? 'SSE' : 'HTTP'} · {row.headersRemoved ? '地址已修改，原请求头已移除；导入后可编辑补充认证。' : Object.keys(row.draft.headers).length ? '文件含认证请求头，内容不回显。' : '不含认证请求头；需要时可在导入后编辑补充。'}</p>}
            {problem && <p className="message-error">{problem}</p>}
            {row.failure && <p className="message-error" role="alert">{row.failure}</p>}
          </section>;
        })}</div>
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{rows.some(row => row.saved) ? '完成' : '取消'}</button><button type="button" className="primary-button" aria-label="导入所选服务" disabled={busy || !canImport} onClick={() => void importSelected()}>{pending === 'save' ? '正在导入…' : `导入所选（${candidates.length}）`}</button></div>
      </> : <>
        <p className="dialog-description">选择要导出的远程服务。文件不包含认证请求头；含私密参数的地址会留空，重新导入时需要补填。</p>
        <p className="tools-help">本地进程服务不参与导出。导出文件中的服务均设为停用。</p>
        <div className="mcp-transfer-list">{servers.filter(server => !server.readonly).map(server => <label className="toggle-field mcp-export-row" key={server.name}><input type="checkbox" aria-label={`选择导出 ${server.name}`} checked={selected.has(server.name)} disabled={busy} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(server.name); else next.delete(server.name); return next; })} /><span>{server.name}<small>{server.url_secret ? '地址含私密参数，将留空' : server.transport === 'sse' ? 'SSE' : 'HTTP'}{server.headers_present ? ' · 请求头不导出' : ''}</small></span></label>)}</div>
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !exportedServers.length} onClick={() => void exportSelected()}>{pending === 'save' ? '正在保存…' : `保存 JSON（${exportedServers.length}）`}</button></div>
      </>}
    </div>
  </Dialog>;
}
