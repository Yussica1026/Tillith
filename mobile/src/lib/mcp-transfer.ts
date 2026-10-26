import type { McpDraft, McpServer } from './tools-api';

export type McpImportItem = { id: number; draft: McpDraft; issue?: string };

export const MAX_MCP_IMPORT_BYTES = 1024 * 1024;

export function parseMcpImport(text: string): McpImportItem[] {
  if (new TextEncoder().encode(text).byteLength > MAX_MCP_IMPORT_BYTES) {
    throw new Error('导入文件不能超过 1 MB。');
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('JSON 格式无效，请检查文件内容。');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || !Object.hasOwn(document, 'mcpServers')) {
    throw new Error('文件必须包含 mcpServers 对象。');
  }
  const servers = (document as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('mcpServers 必须是按服务名称组织的对象。');
  }
  const entries = Object.entries(servers);
  if (entries.length > 50) throw new Error('每次最多导入 50 个 MCP 服务。');

  return entries.map(([name, value], id) => {
    const item: McpImportItem = {
      id, draft: { name, url: '', transport: 'streamable_http', headers: {}, active: false },
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      item.issue = '服务配置必须是对象。';
      return item;
    }
    const config = value as Record<string, unknown>;
    if (['command', 'args', 'env'].some(key => Object.hasOwn(config, key))) {
      item.issue = '不支持导入包含 command、args 或 env 的本地进程配置。';
      return item;
    }
    const transports = ['transport', 'type'].filter(key => Object.hasOwn(config, key))
      .map(key => config[key] === 'http' ? 'streamable_http' : config[key]);
    if (transports.some(value => value !== 'streamable_http' && value !== 'sse')) {
      item.issue = '仅支持 Streamable HTTP 或 SSE，不支持 stdio 和其他协议。';
      return item;
    }
    if (transports.length === 2 && transports[0] !== transports[1]) {
      item.issue = 'transport 与 type 指定的协议不一致。';
      return item;
    }
    item.draft.transport = transports[0] === 'sse' ? 'sse' : 'streamable_http';
    if (Object.hasOwn(config, 'url') && typeof config.url !== 'string') {
      item.issue = '服务地址必须是字符串。';
      return item;
    }
    item.draft.url = typeof config.url === 'string' ? config.url : '';
    if (Object.hasOwn(config, 'active') && typeof config.active !== 'boolean') {
      item.issue = 'active 必须是布尔值。';
      return item;
    }
    if (Object.hasOwn(config, 'headers')) {
      if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers)
          || Object.values(config.headers).some(value => typeof value !== 'string')) {
        item.issue = '请求头必须是名称和内容均为字符串的对象。';
        return item;
      }
      item.draft.headers = Object.fromEntries(Object.entries(config.headers)) as Record<string, string>;
    }
    return item;
  });
}

export function validateMcpImport(item: McpImportItem, existingNames: string[]): string {
  if (item.issue) return item.issue;
  const { name, url, transport, headers } = item.draft;
  if (!name.trim()) return '请填写服务名称。';
  if ([...name].length > 200) return '服务名称不能超过 200 个字符。';
  if (existingNames.some(existing => existing.trim() === name.trim())) {
    return '此服务名称已存在，请修改名称；导入不会覆盖已有服务。';
  }
  if (!url.trim()) return '请补充服务的 HTTP 或 HTTPS 地址。';
  if ([...url].length > 8192) return '服务地址不能超过 8192 个字符。';
  if (/[\u0000-\u001f\\]/.test(url)) return '服务地址不能包含控制字符或反斜杠。';
  try {
    const parsed = new URL(url.trim());
    const authority = url.trim().match(/^https?:\/\/([^/?#]*)/i)?.[1] || '';
    if (!/^https?:\/\//i.test(url.trim()) || !parsed.hostname
        || parsed.username || parsed.password || authority.includes('@') || url.includes('#')) {
      return '请填写不含用户名、密码或片段的 HTTP 或 HTTPS 地址。';
    }
  } catch {
    return '服务地址或端口无效，请填写有效的 HTTP 或 HTTPS 地址。';
  }
  if (transport !== 'streamable_http' && transport !== 'sse') return '不支持此 MCP 协议。';
  for (const [header, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)
        || typeof value !== 'string' || /[\r\n]/.test(value)) {
      return '请求头名称无效或内容包含换行；请求头内容必须是字符串。';
    }
  }
  return '';
}

export function buildMcpExport(servers: McpServer[]): object {
  return {
    mcpServers: Object.fromEntries(servers
      .filter(server => !server.readonly && ['streamable_http', 'sse'].includes(server.transport))
      .map(server => {
        let url = '';
        if (!server.url_secret && !/[?#\u0000-\u001f\\]/.test(server.url)) {
          try {
            const parsed = new URL(server.url.trim());
            const authority = server.url.trim().match(/^https?:\/\/([^/?#]*)/i)?.[1] || '';
            if (/^https?:\/\//i.test(server.url.trim()) && parsed.hostname
                && !parsed.username && !parsed.password && !authority.includes('@')) {
              url = server.url.trim();
            }
          } catch {
            // An invalid address is omitted so it can be filled in before importing.
          }
        }
        return [server.name, { url, transport: server.transport, active: false }];
      })),
  };
}
