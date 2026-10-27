import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { safeError, type Session } from '../lib/api';
import { listToolAudit, type ToolAuditEntry } from '../lib/tool-audit-api';
import { Icon } from './Icon';
import './tool-audit.css';

function auditDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function visibleArgs(value: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === '{}' ? '没有记录参数' : text;
  } catch {
    return '参数无法显示';
  }
}

export function ToolAuditWorkspace({ onBack, onOpen }: { onBack: () => void; onOpen: (session: Session, messageId: string) => void }) {
  const [items, setItems] = useState<ToolAuditEntry[]>([]);
  const [knownSessions, setKnownSessions] = useState<{ id: string; title: string }[]>([]);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const revision = useRef(0);

  async function load(search: string, selectedSession: string, rememberSessions = false): Promise<void> {
    const request = ++revision.current;
    setLoading(true); setError('');
    try {
      const next = await listToolAudit(search, selectedSession);
      if (!active.current || request !== revision.current) return;
      setItems(next);
      if (rememberSessions) {
        const sessions = new Map<string, string>();
        for (const item of next) sessions.set(item.session_id, item.session_title || '新的对话');
        setKnownSessions([...sessions].map(([id, title]) => ({ id, title })));
      }
    } catch (reason) {
      if (active.current && request === revision.current) setError(safeError(reason));
    } finally {
      if (active.current && request === revision.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void load('', '', true);
    return () => { active.current = false; revision.current += 1; };
  }, []);

  const filtersActive = !!appliedQuery || !!sessionId;
  const totalLabel = useMemo(() => filtersActive ? `${items.length} 条匹配` : `${items.length} 次调用`, [filtersActive, items.length]);

  function search(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    setAppliedQuery(value);
    void load(value, sessionId);
  }

  function clearFilters() {
    setQuery(''); setAppliedQuery(''); setSessionId('');
    void load('', '', true);
  }

  return <main className="settings-page audit-workspace">
    <div className="page-heading audit-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><span className="eyebrow">看清工具替你做了什么</span><h1>工具调用记录</h1></div><span className="audit-count" aria-label={totalLabel}>{items.length}</span></div>
    <p className="audit-intro">这里只记录真正执行并返回结果的工具调用。认证信息在写入前已经隐藏。</p>
    <form className="audit-filters" role="search" onSubmit={search}>
      <label className="dialog-field">搜索记录<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="工具名称或结果摘要" /></label>
      <label className="dialog-field">会话<select value={sessionId} onChange={event => { const value = event.target.value; setSessionId(value); void load(appliedQuery, value); }}><option value="">全部会话</option>{knownSessions.map(session => <option value={session.id} key={session.id}>{session.title}</option>)}</select></label>
      <div className="audit-filter-actions"><button type="submit" className="secondary-button" disabled={loading}>搜索</button>{filtersActive && <button type="button" className="text-button" disabled={loading} onClick={clearFilters}>清除筛选</button>}</div>
    </form>
    <div className="audit-toolbar"><span>{totalLabel}</span><button type="button" className="text-button" disabled={loading} onClick={() => void load(appliedQuery, sessionId)}><Icon name="refresh" size={15} />刷新</button></div>
    {error && <div className="provider-notice" role="alert">{error}<button type="button" className="text-button" onClick={() => void load(appliedQuery, sessionId)}>重试</button></div>}
    {loading ? <div className="loading-state"><Icon name="loader" className="spin" />读取调用记录…</div> : items.length === 0 ? <div className="audit-empty"><Icon name="eye" size={30} /><h2>{filtersActive ? '没有找到相符的调用' : '还没有工具调用记录'}</h2><p>{filtersActive ? '换个关键词或清除筛选查看全部。' : '对话中有工具实际完成调用后，会在这里留下已脱敏的记录。'}</p></div> : <section className="audit-list" aria-label="工具调用记录">
      {items.map(item => <article className={`audit-card${item.status === 'error' ? ' audit-card--error' : ''}`} key={item.id}>
        <header><div><span>{item.status === 'error' ? '调用失败' : '调用完成'}</span><h2>{item.tool}</h2><strong>{item.session_title || '新的对话'}</strong></div><time dateTime={item.created_at}>{auditDate(item.created_at)}</time></header>
        <details className="audit-args"><summary>查看已脱敏参数</summary><pre><code>{visibleArgs(item.args_redacted)}</code></pre></details>
        <section className="audit-result" aria-label={item.status === 'error' ? '失败摘要' : '结果摘要'}><span>{item.status === 'error' ? '失败摘要' : '结果摘要'}</span><p>{item.result_summary || '工具没有返回可显示的文字摘要。'}</p></section>
        <footer>{item.message_id ? <button type="button" className="text-button" onClick={() => onOpen({ id: item.session_id, title: item.session_title || '新的对话', updatedAt: item.created_at }, item.message_id!)}><Icon name="chat" size={15} />查看触发消息</button> : <span>触发消息已不可用</span>}</footer>
      </article>)}
    </section>}
  </main>;
}
