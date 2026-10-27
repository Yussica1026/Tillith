import { chatRequest } from './api';

export type ToolAuditEntry = {
  id: string;
  session_id: string;
  session_title: string;
  message_id: string | null;
  tool: string;
  args_redacted: Record<string, unknown>;
  result_summary: string;
  status: 'completed' | 'error';
  created_at: string;
};

export async function listToolAudit(query = '', sessionId = ''): Promise<ToolAuditEntry[]> {
  const items: ToolAuditEntry[] = [];
  for (let page = 1; ; page += 1) {
    const data = await chatRequest('/tillith/tool-audit?' + new URLSearchParams({
      ...(query.trim() ? { q: query.trim() } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      page: String(page),
      page_size: '100',
    }));
    for (const row of Array.isArray(data?.items) ? data.items : []) {
      items.push({
        id: String(row.id),
        session_id: String(row.session_id),
        session_title: typeof row.session_title === 'string' ? row.session_title : '新的对话',
        message_id: row.message_id == null ? null : String(row.message_id),
        tool: typeof row.tool === 'string' ? row.tool : '未知工具',
        args_redacted: row.args_redacted && typeof row.args_redacted === 'object' && !Array.isArray(row.args_redacted) ? row.args_redacted : {},
        result_summary: typeof row.result_summary === 'string' ? row.result_summary : '',
        status: row.status === 'error' ? 'error' : 'completed',
        created_at: typeof row.created_at === 'string' ? row.created_at : '',
      });
    }
    if (!data?.has_more) return items;
  }
}
