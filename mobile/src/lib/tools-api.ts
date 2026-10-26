import { managementRequest } from './api';

export type ToolInfo = {
  name: string; description: string; active: boolean; readonly: boolean;
  origin: 'builtin' | 'mcp' | 'plugin' | 'unknown'; origin_name: string; origin_display_name: string;
  parameters: Record<string, unknown>; permission?: string;
};

export type McpServer = {
  name: string; active: boolean; connected: boolean;
  transport: 'streamable_http' | 'sse' | 'stdio' | 'unsupported';
  url: string; headers_present: boolean; url_secret: boolean; tools: string[];
  readonly: boolean; warning?: string;
};

export type McpDraft = {
  name: string; url: string; transport: 'streamable_http' | 'sse';
  headers: Record<string, string>; clear_headers?: boolean; active: boolean;
};

export async function loadToolsWorkspace(): Promise<{ tools: ToolInfo[]; servers: McpServer[] }> {
  const [tools, servers] = await Promise.all([
    managementRequest('/tillith/tools'), managementRequest('/tillith/mcp/servers'),
  ]);
  return { tools: tools.tools, servers: servers.servers };
}

export async function setToolEnabled(name: string, enabled: boolean): Promise<void> {
  await managementRequest('/tillith/tools/enabled?tool_name=' + encodeURIComponent(name), {
    method: 'PATCH', body: JSON.stringify({ enabled }),
  });
}

export function saveMcpServer(draft: McpDraft, oldName?: string): Promise<McpServer> {
  return managementRequest(oldName === undefined ? '/tillith/mcp/servers' : '/tillith/mcp/servers/by-name?server_name=' + encodeURIComponent(oldName), {
    method: oldName === undefined ? 'POST' : 'PUT', body: JSON.stringify(draft), signal: AbortSignal.timeout(65000),
  });
}

export async function deleteMcpServer(name: string): Promise<void> {
  await managementRequest('/tillith/mcp/servers/by-name?server_name=' + encodeURIComponent(name), { method: 'DELETE' });
}

export function setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServer> {
  return managementRequest('/tillith/mcp/servers/enabled?server_name=' + encodeURIComponent(name), {
    method: 'PATCH', body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(65000),
  });
}

export function testMcpServer(draft: McpDraft, oldName?: string): Promise<{ tools: string[] }> {
  return managementRequest('/tillith/mcp/servers/test' + (oldName === undefined ? '' : '?server_name=' + encodeURIComponent(oldName)), {
    method: 'POST', body: JSON.stringify(draft), signal: AbortSignal.timeout(65000),
  });
}
