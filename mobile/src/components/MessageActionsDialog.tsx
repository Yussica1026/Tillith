import { useState } from 'react';
import type { Message } from '../lib/api';
import { Dialog } from './Dialog';

export type MessageAction = 'edit' | 'regenerate' | 'versions' | 'branch' | 'delete' | 'memory' | 'favorite';

export function MessageActionsDialog({ message, latest, canRetry, busy, onClose, onAction }: { message: Message; latest: boolean; canRetry?: boolean; busy: boolean; onClose: () => void; onAction: (action: MessageAction, text?: string) => void }) {
  const [step, setStep] = useState<'menu' | 'edit' | 'delete'>('menu');
  const [text, setText] = useState(message.text);
  const available = !!message.checkpointId && !!message.saved;
  return <Dialog title={step === 'edit' ? '修改并重新回答' : step === 'delete' ? '删除这一轮？' : message.role === 'user' ? '消息操作' : '回复操作'} onClose={() => { if (!busy) onClose(); }}>
    {step === 'menu' && <><div className="session-menu">
      {message.role === 'user' ? <button type="button" disabled={busy || !available || !latest} onClick={() => setStep('edit')}>修改并重新回答</button> : <button type="button" disabled={busy || (!available && !canRetry) || !latest} onClick={() => onAction('regenerate')}>重新回答</button>}
      <button type="button" disabled={busy || !available} onClick={() => onAction('versions')}>查看这一轮的版本</button>
      <button type="button" disabled={busy || !available} onClick={() => onAction('branch')}>从这一轮创建分支</button>
      {message.saved && (!!message.text.trim() || !!message.attachments?.length) && <button type="button" disabled={busy} onClick={() => onAction('favorite')}>珍藏这条消息</button>}
      <button type="button" disabled={busy || !message.saved || !message.text.trim()} onClick={() => onAction('memory')}>记为记忆</button>
      <button type="button" className="danger-text" disabled={busy || !available} onClick={() => setStep('delete')}>删除这一轮</button>
    </div>{!available ? <p className="field-help">这条消息没有可用的上下文记录。更新前产生的旧消息仍可阅读和复制。</p> : !latest && <p className="field-help">修改和重答用于最后一轮。要继续较早的内容，可先创建分支。</p>}</>}
    {step === 'edit' && <form onSubmit={(event) => { event.preventDefault(); onAction('edit', text); }}><label className="dialog-field">消息内容<textarea autoFocus rows={7} value={text} onChange={(event) => setText(event.target.value)} disabled={busy} /></label><p className="field-help">保留本条附件。旧回答存入版本记录，重新回答会调用当前选择的模型。</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setStep('menu')}>返回</button><button type="submit" className="primary-button" disabled={busy || (!text.trim() && !message.attachments?.length)}>修改并重新回答</button></div></form>}
    {step === 'delete' && <><p className="dialog-description">将删除这一轮的用户消息、回答和版本记录，并更新模型上下文。此操作无法撤销。</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setStep('menu')}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => onAction('delete')}>{busy ? '正在删除…' : '删除这一轮'}</button></div></>}
  </Dialog>;
}
