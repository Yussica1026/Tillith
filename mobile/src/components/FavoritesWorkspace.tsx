import { useEffect, useRef, useState, type FormEvent } from 'react';
import { deleteFavorite, listFavorites, safeError, type Favorite, type Session } from '../lib/api';
import { Icon } from './Icon';
import { MessageContent } from './MessageContent';
import './favorites.css';

function favoriteDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '保存时间未知' : date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const attachmentLabels = { image: '图片', record: '语音', file: '文件', video: '视频' } as const;

export function FavoritesWorkspace({ onBack, onOpen }: { onBack: () => void; onOpen: (session: Session, messageId: string) => void }) {
  const [items, setItems] = useState<Favorite[]>([]);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const revision = useRef(0);

  async function load(value: string): Promise<void> {
    const request = ++revision.current;
    setLoading(true); setError('');
    try {
      const next = await listFavorites(value);
      if (active.current && request === revision.current) setItems(next);
    } catch (reason) {
      if (active.current && request === revision.current) setError(safeError(reason));
    } finally {
      if (active.current && request === revision.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void load('');
    return () => { active.current = false; revision.current += 1; };
  }, []);

  function search(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    setAppliedQuery(value);
    void load(value);
  }

  async function remove(item: Favorite) {
    if (pending) return;
    setPending(item.id); setError('');
    try {
      await deleteFavorite(item.id);
      if (active.current) setItems(current => current.filter(candidate => candidate.id !== item.id));
    } catch (reason) {
      if (active.current) setError(safeError(reason));
    } finally {
      if (active.current) setPending(null);
    }
  }

  return <main className="settings-page favorites-workspace">
    <div className="page-heading favorites-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><span className="eyebrow">留下想再次读到的话</span><h1>珍藏</h1></div><span className="favorite-count" aria-label={`共 ${items.length} 条珍藏`}>{items.length}</span></div>
    <form className="favorites-search" role="search" onSubmit={search}>
      <label><span className="visually-hidden">搜索珍藏正文</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索珍藏正文" /></label>
      <button type="submit" className="secondary-button" disabled={loading}>搜索</button>
      {appliedQuery && <button type="button" className="text-button" disabled={loading} onClick={() => { setQuery(''); setAppliedQuery(''); void load(''); }}>清除</button>}
    </form>
    {error && <div className="provider-notice" role="alert">{error}<button type="button" className="text-button" onClick={() => void load(appliedQuery)}>重试</button></div>}
    {loading ? <div className="loading-state"><Icon name="loader" className="spin" />读取珍藏…</div> : items.length === 0 ? <div className="favorites-empty"><span className="favorite-ribbon" aria-hidden="true"><Icon name="bookmark" /></span><h2>{appliedQuery ? '没有找到相符的珍藏' : '还没有珍藏'}</h2><p>{appliedQuery ? '换一个词，或清除搜索查看全部。' : '在已保存的消息里打开“操作”，就能把这一刻留在这里。'}</p></div> : <section className="favorite-list" aria-label="珍藏列表">
      {items.map(item => <article className="favorite-card" key={item.id}>
        <span className="favorite-ribbon" aria-hidden="true"><Icon name="bookmark" size={17} /></span>
        <header><div><span>{item.role === 'assistant' ? 'Tillith 的回复' : '我的消息'}</span><strong>{item.session_title || '新的对话'}</strong></div><time dateTime={item.created_at}>{favoriteDate(item.created_at)}</time></header>
        {item.text ? (item.role === 'assistant' ? <MessageContent text={item.text} /> : <p className="favorite-text">{item.text}</p>) : <p className="favorite-text favorite-text--empty">这条珍藏只有附件</p>}
        {!!item.attachments?.length && <ul className="favorite-attachments" aria-label="附件快照">{item.attachments.map((attachment, index) => <li key={`${attachment.id}-${index}`}><Icon name={attachment.type === 'image' ? 'image' : 'file'} size={15} /><span>{attachment.name}</span><small>{attachmentLabels[attachment.type]}</small></li>)}</ul>}
        <footer><button type="button" className="text-button" onClick={() => onOpen({ id: item.session_id, title: item.session_title || '新的对话', updatedAt: item.created_at }, item.message_id)}><Icon name="chat" size={15} />回到原对话</button><button type="button" className="text-button favorite-delete" disabled={pending === item.id} onClick={() => void remove(item)}><Icon name="trash" size={15} />{pending === item.id ? '正在移除…' : '移出珍藏'}</button></footer>
      </article>)}
    </section>}
  </main>;
}
