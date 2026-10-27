import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { safeError } from '../lib/api';
import { loadWebSearchProfiles, saveWebSearchProfile, type WebSearchProfile, type WebSearchProvider, type WebSearchWorkspace as Workspace } from '../lib/web-search-api';
import { Icon } from './Icon';
import './web-search.css';

type Draft = Pick<WebSearchProfile, 'enabled' | 'provider' | 'show_sources'>;

function draftFrom(profile: WebSearchProfile): Draft {
  return { enabled: profile.enabled, provider: profile.provider, show_sources: profile.show_sources };
}

export function WebSearchWorkspace({ onBack, onSettings }: { onBack: () => void; onSettings: () => void }) {
  const [data, setData] = useState<Workspace>();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft>({ enabled: false, provider: 'tavily', show_sources: false });
  const [secret, setSecret] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function selectProfile(profile: WebSearchProfile) {
    setSelectedId(profile.id); setDraft(draftFrom(profile)); setSecret(''); setClearKey(false); setNotice('');
  }

  async function refresh(preferredId = selectedId) {
    setLoading(true); setError('');
    try {
      const next = await loadWebSearchProfiles();
      setData(next);
      const profile = next.profiles.find(item => item.id === preferredId) || next.profiles[0];
      if (profile) selectProfile(profile);
      else setSelectedId('');
    } catch (reason) { setError(safeError(reason)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(''); }, []);
  const selected = data?.profiles.find(profile => profile.id === selectedId);
  const provider = data?.providers.find(item => item.id === draft.provider);
  const configured = !!selected?.configured_providers.includes(draft.provider);
  const providerName = provider?.label || draft.provider;
  const secretLines = useMemo(() => secret.split(/\r?\n/).map(value => value.trim()).filter(Boolean), [secret]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || !provider || saving) return;
    setSaving(true); setError(''); setNotice('');
    const apiKey = provider.key_kind === 'single' ? secret.trim() : secretLines;
    try {
      const updated = await saveWebSearchProfile(selected.id, {
        ...draft,
        ...(clearKey ? { clear_key: true } : provider.key_kind === 'single' ? (apiKey ? { api_key: apiKey } : {}) : secretLines.length ? { api_key: secretLines } : {}),
      });
      setData(current => current && ({ ...current, profiles: current.profiles.map(item => item.id === updated.id ? updated : item) }));
      setDraft(draftFrom(updated)); setSecret(''); setClearKey(false);
      setNotice(`已保存「${updated.name}」的联网搜索设置。新对话和后续请求会按该配置档案生效。`);
    } catch (reason) { setError(safeError(reason)); }
    finally { setSaving(false); }
  }

  return <main className="settings-page web-search-workspace">
    <div className="page-heading web-search-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><span className="eyebrow">给回答一条可核对的来路</span><h1>联网搜索</h1></div><span className={`search-compass${draft.enabled ? ' is-enabled' : ''}`} aria-hidden="true"><i /></span></div>
    <p className="web-search-intro">搜索设置跟随配置档案。聊天选中哪个档案，就使用它保存的搜索服务；密钥不会回传到这台设备。</p>
    {error && <div className="provider-notice" role="alert"><p>{error}</p><div className="web-search-notice-actions"><button type="button" className="text-button" onClick={() => void refresh()}>重试</button><button type="button" className="text-button" onClick={onSettings}>检查管理密钥</button></div></div>}
    {notice && <p className="provider-notice" role="status">{notice}</p>}
    {loading ? <div className="loading-state"><Icon name="loader" className="spin" />读取搜索配置…</div> : !data?.profiles.length ? <div className="web-search-empty"><Icon name="cloud" size={28} /><h2>还没有配置档案</h2><p>先在核心中建立配置档案，再回来为它设置联网搜索。</p></div> : selected && <form className="web-search-form" onSubmit={(event) => void save(event)}>
      <section className="web-search-card">
        <label className="dialog-field">配置档案<select value={selectedId} disabled={saving} onChange={event => { const value = data.profiles.find(item => item.id === event.target.value); if (value) selectProfile(value); }}>{data.profiles.map(profile => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>
        <p className="field-help">只修改这个档案的搜索设置，不会改动模型、人格或其他档案。</p>
      </section>
      <section className="web-search-card web-search-card--route">
        <label className="toggle-field"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>允许这个配置档案使用网页搜索</span></label>
        <label className="dialog-field">搜索服务<select value={draft.provider} disabled={saving} onChange={event => { setDraft({ ...draft, provider: event.target.value }); setSecret(''); setClearKey(false); }}>{data.providers.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
        <label className="toggle-field"><input type="checkbox" checked={draft.show_sources} disabled={saving || !draft.enabled} onChange={event => setDraft({ ...draft, show_sources: event.target.checked })} /><span>在回答中显示来源引用</span></label>
      </section>
      {provider && <section className="web-search-card web-search-secret-card">
        <div className="web-search-secret-heading"><div><span>当前服务</span><h2>{provider.label}</h2></div><strong className={configured ? 'is-configured' : ''}>{configured ? '密钥已配置' : provider.anonymous ? '可匿名使用' : '尚未配置密钥'}</strong></div>
        <label className="dialog-field">{provider.key_kind === 'multiple' ? '新 API Key（每行一个）' : '新 API Key'}{provider.key_kind === 'multiple' ? <textarea className="search-secret-input" aria-label="新 API Key，每行一个" autoComplete="new-password" spellCheck={false} rows={4} value={secret} disabled={saving || clearKey} placeholder={configured ? '已配置，留空保持不变' : provider.anonymous ? '可留空使用匿名额度' : '每行填写一个 API Key'} onChange={event => setSecret(event.target.value)} /> : <input type="password" autoComplete="new-password" spellCheck={false} value={secret} disabled={saving || clearKey} placeholder={configured ? '已配置，留空保持不变' : provider.anonymous ? '可留空使用匿名额度' : '填写 API Key'} onChange={event => setSecret(event.target.value)} />}</label>
        <p className="field-help">这里永远不会显示旧密钥。留空会保留 {providerName} 已保存的值；切换服务也不会把旧密钥带过去。</p>
        {configured && <label className="toggle-field web-search-clear"><input type="checkbox" checked={clearKey} disabled={saving} onChange={event => { setClearKey(event.target.checked); if (event.target.checked) setSecret(''); }} /><span>清除 {providerName} 已保存的密钥</span></label>}
      </section>}
      <button type="submit" className="primary-button web-search-save" disabled={saving || !provider}>{saving ? <><Icon name="loader" className="spin" size={17} />正在保存…</> : <><Icon name="check" size={17} />保存搜索设置</>}</button>
    </form>}
  </main>;
}
