import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { Dialog } from './Dialog';
import { MessageContent } from './MessageContent';

type VersionList = Awaited<ReturnType<typeof api.listVersions>>;

export function MessageVersionsDialog({ sessionId, messageId, onClose, onRestore }: { sessionId: string; messageId: string; onClose: () => void; onRestore: () => Promise<void> }) {
  const [data, setData] = useState<VersionList>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string>();
  useEffect(() => {
    let active = true;
    void api.listVersions(sessionId, messageId).then((value) => { if (active) setData(value); }).catch((reason) => { if (active) setError(api.safeError(reason)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [sessionId, messageId]);
  async function select(versionId: string) {
    if (!data || busy) return;
    setBusy(true); setError('');
    try { await api.restoreVersion(sessionId, data.user_message_id, versionId); await onRestore(); onClose(); }
    catch (reason) { setError(api.safeError(reason)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!data || !deleting || busy) return;
    setBusy(true); setError('');
    try { await api.deleteArchivedVersion(sessionId, data.user_message_id, deleting); setData(await api.listVersions(sessionId, data.user_message_id)); setDeleting(undefined); }
    catch (reason) { setError(api.safeError(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog title="这一轮的版本" onClose={() => { if (!busy) onClose(); }}>
    {error && <p role="alert" className="message-error">{error}</p>}
    {busy && !data && <p role="status">正在读取版本…</p>}
    {data && <><p className="field-help">{data.can_select ? '切换版本会同时恢复该轮消息和模型上下文。' : '较早的轮次可以查看版本；需要继续时，请从消息菜单创建分支。'}</p><div className="version-list">{data.versions.map((version, index) => <section className="version-card" key={version.id}><header><strong>版本 {index + 1}{version.current ? ' · 当前' : ''}</strong><time>{new Date(version.created_at).toLocaleString()}</time></header>{version.messages.map((content, partIndex) => { const message = api.messageFromContent(content, String(partIndex)); return <div className="version-message" key={partIndex}><small>{message.role === 'user' ? '我' : 'Tillith'}</small><MessageContent text={message.text} />{message.attachments?.map((item) => <p key={item.id} className="field-help">附件：{item.name}</p>)}</div>; })}{!version.current && <div className="dialog-actions"><button type="button" className="text-button danger-text" disabled={busy} onClick={() => setDeleting(version.id)}>删除此版本</button><button type="button" className="secondary-button" disabled={busy || !data.can_select} onClick={() => void select(version.id)}>切换到此版本</button></div>}{deleting === version.id && <div className="version-delete"><p>永久删除这个历史版本？</p><button type="button" className="text-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>确认删除版本</button></div>}</section>)}</div></>}
  </Dialog>;
}
