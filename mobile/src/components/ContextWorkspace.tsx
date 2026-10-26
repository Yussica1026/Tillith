import { useEffect, useState } from 'react';
import { safeError } from '../lib/api';
import { listContextSources, type ContextSource } from '../lib/context-api';
import { Icon } from './Icon';
import { PersonaPanel } from './PersonaPanel';
import { WorldbookPanel } from './WorldbookPanel';
import { MemoryPanel } from './MemoryPanel';
import './context.css';

type ContextTab = 'personas' | 'worldbooks' | 'memories';
export function ContextWorkspace({ onBack, onSettings, storageId, backLabel = '更多', initialTab = 'personas', sessionId, onOpenPersona }: { onBack: () => void; onSettings: () => void; storageId: string; backLabel?: string; initialTab?: ContextTab; sessionId?: string; onOpenPersona?: (personaId: string, newSession: boolean) => Promise<void> }) {
  const [tab, setTab] = useState<ContextTab>(initialTab);
  const [showSources, setShowSources] = useState(false);
  return <main className="settings-page context-workspace">
    <div className="page-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />{backLabel}</button><span className="eyebrow">让每次对话有来处</span><h1>人格与上下文</h1></div></div>
    <nav className="context-tabs" aria-label="上下文工作区">{([['personas', '人格'], ['worldbooks', '世界书'], ['memories', '记忆']] as const).map(([id, label]) => <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === 'personas' && <PersonaPanel storageId={storageId} onSettings={onSettings} onOpenPersona={onOpenPersona} />}
    {tab === 'worldbooks' && <WorldbookPanel />}
    {tab === 'memories' && <MemoryPanel />}
    {sessionId && <section className="context-source-entry"><button type="button" className="text-button" aria-expanded={showSources} onClick={() => setShowSources(!showSources)}>查看当前会话的注入来源</button>{showSources && <ContextSources sessionId={sessionId} />}</section>}
  </main>;
}

export function ContextSources({ sessionId, checkpointId, runId }: { sessionId: string; checkpointId?: string; runId?: string }) {
  const [sources, setSources] = useState<ContextSource[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => { let active = true; setSources(undefined); setError(''); void listContextSources(sessionId, checkpointId, runId).then(value => { if (active) setSources(value); }).catch(reason => { if (active) setError(safeError(reason)); }); return () => { active = false; }; }, [sessionId, checkpointId, runId, revision]);
  return <section className="context-sources" aria-label="实际注入来源"><div className="context-toolbar"><h2>本轮对话的来处</h2><button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>刷新来源</button></div>{error && <p className="context-notice" role="alert">{error}</p>}{!error && !sources && <p className="field-help" role="status">正在读取实际注入记录…</p>}{sources?.length === 0 && <p className="field-help">还没有记录到上下文注入。启用世界书或记忆并完成一次对话后，可在这里查看实际来源。</p>}{sources?.map((source, index) => <details className="context-source-round" key={source.run_id || index} open={index === 0}><summary>{source.persona_id || '默认人格'} · {source.created_at ? new Date(source.created_at).toLocaleString() : '本轮'}<small>{source.worldbooks.length} 条世界书 · {source.memories.length} 条记忆</small></summary>{source.worldbooks.map(entry => <article className="context-source-text" key={entry.book_id + entry.entry_id}><strong>{entry.title || '未命名条目'}</strong><span>世界书 · {({ before_system: '系统指令之前', after_system: '系统指令之后', before_history: '聊天历史之前', after_history: '聊天历史之后' } as Record<string, string>)[entry.position] || entry.position}</span><p>{entry.text}</p></article>)}{source.memories.map(memory => <article className="context-source-text" key={memory.id}><strong>记忆 · {memory.type}</strong>{memory.source_message_id && <span>来源消息 #{memory.source_message_id}</span>}<p>{memory.text}</p></article>)}{source.worldbooks.length + source.memories.length === 0 && <p className="field-help">这轮没有注入世界书条目或记忆。</p>}{source.memory_tools_enabled && <p className="field-help">这轮已允许模型使用记忆工具。</p>}</details>)}</section>;
}
