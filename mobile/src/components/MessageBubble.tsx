import { useEffect, useId, useRef, useState } from 'react';
import { attachmentUrl, type Attachment, type Message } from '../lib/api';
import { Brand } from './Brand';
import { Icon } from './Icon';
import { CopyButton, MessageContent } from './MessageContent';

function ImagePreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const reference = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = reference.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={reference} className="message-image-preview" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2 id={titleId}>{name}</h2><button type="button" className="icon-button" aria-label="关闭图片预览" onClick={onClose}><Icon name="close" /></button></header>
    <img className="message-preview-image" src={url} alt={name} />
  </dialog>;
}

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let active = true;
    let resource: string | undefined;
    setFailed(false);
    setPreview(false);
    setUrl(undefined);
    void attachmentUrl(attachment).then((value) => {
      resource = value;
      if (active) setUrl(value);
      else if (value.startsWith('blob:')) URL.revokeObjectURL(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (resource?.startsWith('blob:')) URL.revokeObjectURL(resource); };
  }, [attachment.id, attachment.name, attachment.type]);
  if (failed) return <span className="attachment-unavailable"><Icon name="file" />{attachment.name} · 暂时无法读取</span>;
  if (!url) return <span className="attachment-unavailable"><Icon name="loader" className="spin" />读取附件…</span>;
  return <div className="message-attachment">
    {attachment.type === 'image' && <><button type="button" className="message-image-button" aria-label={`预览图片：${attachment.name}`} onClick={() => setPreview(true)}><img src={url} alt={attachment.name} onError={() => setFailed(true)} /></button>{preview && <ImagePreview url={url} name={attachment.name} onClose={() => setPreview(false)} />}</>}
    {attachment.type === 'record' && <audio controls preload="metadata" src={url} aria-label={attachment.name} />}
    {attachment.type === 'video' && <video controls preload="metadata" src={url} aria-label={attachment.name} />}
    <a className="attachment-download" href={url} download={attachment.name}><Icon name="file" size={16} /><span>{attachment.name}</span><span aria-hidden="true">↓</span></a>
  </div>;
}

export function MessageBubble({ message, onManage, disabled }: { message: Message; onManage?: () => void; disabled?: boolean }) {
  const assistant = message.role === 'assistant';
  return <article id={'message-' + message.id} tabIndex={-1} className={`message message--${message.role} ${message.status === 'error' ? 'message--error' : ''}`} aria-label={assistant ? 'Tillith 的回复' : '我的消息'}>
    {assistant && <div className="message-author"><Brand compact /><span>Tillith</span>{message.status === 'streaming' && <span className="writing-label">正在回复</span>}</div>}
    <div className="message-body">
      {message.reasoning && <details className="message-reasoning"><summary>思考过程</summary><p>{message.reasoning}</p></details>}
      {message.text && (assistant ? <MessageContent text={message.text} /> : <div className="message-text">{message.text}</div>)}
      {message.attachments?.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}
      {assistant && message.status === 'streaming' && !message.text && !message.reasoning && <span className="typing-dots" aria-label="等待回复"><i /><i /><i /></span>}
      {message.status === 'error' && <p className="message-error">回复未完成，请检查连接后重试。</p>}
      {message.status !== 'streaming' && <div className="message-actions">{message.text && <CopyButton text={message.text} label={assistant ? '复制回复' : '复制消息'} />}{onManage && <button type="button" className="text-button" disabled={disabled} onClick={onManage} aria-label={assistant ? '回复操作' : '消息操作'}><Icon name="more" size={16} />操作</button>}</div>}
      {assistant && message.status === 'done' && <p className="message-usage">{message.usage ? `输入 ${message.usage.input ?? '未提供'} · 输出 ${message.usage.output ?? '未提供'} tokens` : '用量未提供'}</p>}
    </div>
  </article>;
}
