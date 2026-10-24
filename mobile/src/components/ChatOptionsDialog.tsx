import { useEffect, useState } from 'react';
import { listChatOptions, type ChatOptions, type ChatSelection } from '../lib/api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function ChatOptionsDialog({ value, onApply, onClose }: { value?: ChatSelection; onApply: (value: ChatSelection) => void; onClose: () => void }) {
  const [configId, setConfigId] = useState(value?.configId || '');
  const [providerId, setProviderId] = useState(value?.providerId || '');
  const [options, setOptions] = useState<ChatOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void listChatOptions(configId || undefined).then((next) => {
      if (!active) return;
      setOptions(next);
      setProviderId((id) => next.providers.some((provider) => provider.id === id) ? id : '');
    }).catch(() => { if (active) setError('无法读取模型配置，请检查核心连接后重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [configId, revision]);
  const provider = options?.providers.find((item) => item.id === providerId);
  return <Dialog title="本次会话的模型" onClose={onClose}>
    <p className="dialog-description">选择下一条消息使用的配置与模型。</p>
    {error ? <div className="options-status" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRevision((old) => old + 1)}>重新读取</button></div> : <>
      <label className="dialog-field options-field">核心配置<select aria-label="核心配置" value={configId || options?.default_config_id || ''} disabled={loading || !options} onChange={(event) => { setConfigId(event.target.value); setProviderId(''); }}>
        {!options && <option value="">正在读取…</option>}{options?.configs.map((config) => <option key={config.id} value={config.id}>{config.name}</option>)}
      </select></label>
      <label className="dialog-field options-field">聊天模型<select aria-label="聊天模型" value={providerId} disabled={loading || !options} onChange={(event) => setProviderId(event.target.value)}>
        <option value="">跟随核心默认</option>{options?.providers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.model ? ` · ${item.model}` : ''}</option>)}
      </select></label>
      {loading ? <p className="options-status" role="status"><Icon name="loader" className="spin" size={16} /> 正在读取配置…</p> : options?.providers.length === 0 ? <p className="options-status" role="status">当前配置还没有可用的聊天模型。请先在核心中配置模型服务，完成后重新读取。</p> : <p className="field-help">{provider ? `当前模型：${provider.model || provider.name}` : '由核心根据当前配置选择默认模型。'}</p>}
    </>}
    <div className="dialog-actions"><button type="button" className="secondary-button" disabled={loading} onClick={() => setRevision((old) => old + 1)}>刷新</button><button type="button" className="primary-button" disabled={loading || !!error || !options} onClick={() => onApply({ configId: configId || options!.default_config_id, providerId, model: provider?.model || '' })}>应用</button></div>
  </Dialog>;
}
