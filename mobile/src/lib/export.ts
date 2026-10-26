import { Capacitor, registerPlugin } from '@capacitor/core';
import { exportConversationBackup, loadMessages, type Session } from './api';

const Files = registerPlugin<{ saveText(options: { name: string; text: string }): Promise<{ cancelled?: boolean; bytesWritten?: number }> }>('TillithFiles');

export async function exportConversation(session: Session, format: 'json' | 'md' | 'backup'): Promise<boolean> {
  if (format === 'backup') {
    const { blob, filename } = await exportConversationBackup(session.id);
    if (Capacitor.isNativePlatform()) return !(await Files.saveText({ name: filename, text: await blob.text() })).cancelled;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const messages = (await loadMessages(session.id)).map(({ role, text, attachments }) => ({ role, text, ...(attachments?.length ? { attachments: attachments.map(({ name, type }) => ({ name, type })) } : {}) }));
  const content = format === 'json' ? JSON.stringify({ format: 'tillith-conversation-v1', title: session.title, messages }, null, 2) : `# ${session.title}\n\n` + messages.map((message) => `## ${message.role === 'user' ? '我' : 'Tillith'}\n\n${message.text}${message.attachments?.length ? '\n\n' + message.attachments.map((item) => `[附件：${item.name}]`).join('\n') : ''}`).join('\n\n---\n\n');
  let basename = (session.title || 'Tillith-会话').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  while (new TextEncoder().encode(basename).length > 160) basename = Array.from(basename).slice(0, -1).join('');
  const name = (basename || 'Tillith') + '.' + format;
  if (Capacitor.isNativePlatform()) return !(await Files.saveText({ name, text: content })).cancelled;
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
