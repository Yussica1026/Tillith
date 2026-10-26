import type { Session, SessionMeta } from '../lib/api';
import { Icon } from './Icon';

export function SessionList({ sessions, metadata, disabled, onOpen, onManage }: { sessions: Session[]; metadata: Record<string, SessionMeta>; disabled: boolean; onOpen: (session: Session) => void; onManage: (session: Session) => void }) {
  return <section className="session-section" aria-label="会话列表"><div className="section-label">对话记录<span>{sessions.length}</span></div><ul className="session-list">{sessions.map((session) => <li className="session-row" key={session.id}>
    <button className="session-open" type="button" onClick={() => onOpen(session)} disabled={disabled}><span className="session-icon"><Icon name="chat" /></span><span><strong>{session.title || '未命名对话'}</strong><small>{metadata[session.id]?.pinned && <span className="session-badge">置顶 · </span>}{metadata[session.id]?.starred && <span className="session-badge">星标 · </span>}{metadata[session.id]?.archived && <span className="session-badge">已归档 · </span>}{Number.isNaN(new Date(session.updatedAt).getTime()) ? '已保存的对话' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(session.updatedAt))}</small></span></button>
    <button type="button" className="icon-button" aria-label={`管理会话：${session.title || '未命名对话'}`} disabled={disabled} onClick={() => onManage(session)}><Icon name="more" size={19} /></button>
  </li>)}</ul></section>;
}
