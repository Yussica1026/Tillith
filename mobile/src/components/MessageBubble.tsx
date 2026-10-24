import { useEffect, useState } from 'react';
import { attachmentUrl, type Attachment, type Message } from '../lib/api';
import { Brand } from './Brand';
import { Icon } from './Icon';

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let resource: string | undefined;
    setFailed(false);
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
    {attachment.type === 'image' && <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.name} onError={() => setFailed(true)} /></a>}
    {attachment.type === 'record' && <audio controls preload="metadata" src={url} aria-label={attachment.name} />}
    {attachment.type === 'video' && <video controls preload="metadata" src={url} aria-label={attachment.name} />}
    <a className="attachment-download" href={url} download={attachment.name}><Icon name="file" size={16} /><span>{attachment.name}</span><span aria-hidden="true">↓</span></a>
  </div>;
}

export function MessageBubble({ message }: { message: Message }) {
  const assistant = message.role === 'assistant';
  return <article className={`message message--${message.role} ${message.status === 'error' ? 'message--error' : ''}`} aria-label={assistant ? 'Tillith 的回复' : '我的消息'}>
    {assistant && <div className="message-author"><Brand compact /><span>Tillith</span>{message.status === 'streaming' && <span className="writing-label">正在回复</span>}</div>}
    <div className="message-body">
      {message.reasoning && <details className="message-reasoning"><summary>思考过程</summary><p>{message.reasoning}</p></details>}
      {message.text && <div className="message-text">{message.text}</div>}
      {message.attachments?.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}
      {assistant && message.status === 'streaming' && !message.text && !message.reasoning && <span className="typing-dots" aria-label="等待回复"><i /><i /><i /></span>}
      {message.status === 'error' && <p className="message-error">回复未完成，请检查连接后重试。</p>}
    </div>
  </article>;
}
