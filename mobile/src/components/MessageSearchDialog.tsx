import { useEffect, useState } from 'react';
import { safeError, searchMessages, type SearchMatch } from '../lib/api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function MessageSearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (match: SearchMatch) => void }) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SearchMatch[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setItems([]); setHasMore(false); setError('');
    if (!query.trim()) { setBusy(false); return; }
    setBusy(true);
    const timer = window.setTimeout(() => {
      void searchMessages(query.trim(), role, page).then((data) => {
        if (active) { setItems(data.items); setHasMore(data.has_more); }
      }).catch((reason) => { if (active) setError(safeError(reason)); }).finally(() => { if (active) setBusy(false); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, role, page]);
  return <Dialog title="搜索消息内容" onClose={onClose}>
    <label className="dialog-field">关键词<input autoFocus type="search" maxLength={200} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="想找的那句话" /></label>
    <label className="dialog-field options-field">发言人<select aria-label="发言人" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }}><option value="">全部消息</option><option value="user">我的消息</option><option value="assistant">助手回复</option></select></label>
    <div className="message-search-results" aria-live="polite">{busy ? <p className="options-status"><Icon name="loader" className="spin" size={16} /> 正在查找…</p> : error ? <p className="message-error">{error}</p> : !query.trim() ? <p className="field-help">搜索当前身份的聊天正文，点击结果回到对应消息。</p> : items.length === 0 ? <p className="field-help">没有找到匹配的消息。</p> : items.map((item) => <button className="search-result" type="button" key={item.message_id} onClick={() => onOpen(item)}><strong>{item.session_title || '未命名对话'}</strong><span>{item.role === 'user' ? '我' : 'Tillith'} · {item.text}</span></button>)}</div>
    {(page > 1 || hasMore) && <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy || page === 1} onClick={() => setPage((old) => old - 1)}>上一页</button><span className="page-number">{page}</span><button type="button" className="secondary-button" disabled={busy || !hasMore} onClick={() => setPage((old) => old + 1)}>下一页</button></div>}
  </Dialog>;
}
