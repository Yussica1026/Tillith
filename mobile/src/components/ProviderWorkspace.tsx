import { useEffect, useState, type FormEvent } from 'react';
import * as providersApi from '../lib/provider-api';
import { safeError } from '../lib/api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { SchemaForm, type ConfigValue, type FieldSchema } from './SchemaForm';

type Workspace = Awaited<ReturnType<typeof providersApi.loadProviderWorkspace>>;
type Editing = { kind: 'source' | 'provider'; id?: string; sourceId?: string; config: ConfigValue; secrets: string[]; template: string };

export function ProviderWorkspace({ onBack, onSettings }: { onBack: () => void; onSettings: () => void }) {
  const [data, setData] = useState<Workspace>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [deleting, setDeleting] = useState<{ kind: 'source' | 'provider'; id: string }>();
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<string[]>([]);
  const [dialogError, setDialogError] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { setData(await providersApi.loadProviderWorkspace()); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const templates = Object.entries(data?.schema.config_template || {}).filter(([, item]) => (item as ConfigValue).provider_type === 'chat_completion') as [string, ConfigValue][];
  const fields = (data?.schema.items || {}) as Record<string, FieldSchema>;
  function edit(kind: Editing['kind'], config?: ConfigValue, sourceId?: string) {
    const first = templates[0];
    const blank = kind === 'source' ? structuredClone(first?.[1] || {}) : { id: '', provider_source_id: sourceId, model: '', enable: true, custom_extra_body: {} };
    setInvalid({}); setModels([]); setDialogError('');
    setEditing({ kind, id: config ? String(config.id) : undefined, sourceId: sourceId || (typeof config?.provider_source_id === 'string' ? config.provider_source_id : undefined), config: structuredClone(config || blank), secrets: (config?.secret_fields_present || []) as string[], template: first?.[0] || '' });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy || Object.values(invalid).some(Boolean)) return;
    if (!String(editing.config.id || '').trim() || editing.kind === 'provider' && !String(editing.config.model || '').trim()) { setDialogError('请填写名称和模型。'); return; }
    setBusy(true); setDialogError('');
    try {
      if (editing.kind === 'source') await providersApi.saveProviderSource(editing.config, editing.id);
      else await providersApi.saveProvider(editing.config, editing.id, editing.sourceId);
      setEditing(undefined); setData(await providersApi.loadProviderWorkspace()); setNotice('线路已保存，可回到会话选择模型。');
    } catch (reason) { setDialogError(safeError(reason)); }
    finally { setBusy(false); }
  }
  async function operation(task: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await task(); setData(await providersApi.loadProviderWorkspace()); setNotice(message); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  async function test(id: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('正在向模型服务发送测试请求…');
    try { const result = await providersApi.testProvider(id); setNotice(`${result.ok ? '测试通过' : '测试未通过'}：${safeError(result.message)}`); }
    catch (reason) { setNotice(''); setError(safeError(reason)); }
    finally { setBusy(false); }
  }
  const modelCard = (provider: ConfigValue) => <article className="provider-model" key={String(provider.id)}><div><strong>{String(provider.id)}</strong><p>{String(provider.model || '未设置模型')} · {provider.enable === false ? '已停用' : '已启用'}</p></div><div className="provider-actions"><button type="button" className="text-button" disabled={busy} onClick={() => edit('provider', provider)}>编辑模型</button><button type="button" className="text-button" disabled={busy} onClick={() => void test(String(provider.id))}>测试连接</button><button type="button" className="text-button" disabled={busy} onClick={() => void operation(() => providersApi.setProviderEnabled(String(provider.id), provider.enable === false), provider.enable === false ? '模型已启用。' : '模型已停用。')}>{provider.enable === false ? '启用' : '停用'}</button><button type="button" className="text-button danger-text" disabled={busy} onClick={() => setDeleting({ kind: 'provider', id: String(provider.id) })}>删除模型</button></div></article>;
  return <main className="settings-page provider-workspace"><div className="page-heading"><div><button type="button" className="text-button" onClick={onBack}><Icon name="back" size={16} />更多</button><h1>线路与模型</h1></div><button type="button" className="icon-button" aria-label="刷新线路" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" className={busy ? 'spin' : ''} /></button></div>
    <p className="field-help">先配置服务地址与密钥，再添加具体模型。连接测试会向服务商发送请求。</p>
    {error && <div className="provider-notice" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={onSettings}>检查管理密钥</button></div>}
    {notice && <p className="provider-notice" role="status">{notice}</p>}
    {data && <><button type="button" className="primary-button" disabled={busy || !templates.length} onClick={() => edit('source')}><Icon name="plus" size={17} />添加服务</button><div className="provider-sources">{data.sources.map((source) => <section className="provider-source" key={String(source.id)}><header><h2>{String(source.id)}</h2><span>{String(source.type || '')}</span></header><p className="field-help">{(source.secret_fields_present as string[] | undefined)?.length ? '凭据已配置' : '尚未配置凭据'}</p><div className="provider-actions"><button type="button" className="text-button" disabled={busy} onClick={() => edit('source', source)}>编辑服务</button><button type="button" className="text-button" disabled={busy} onClick={() => edit('provider', undefined, String(source.id))}>添加模型</button><button type="button" className="text-button danger-text" disabled={busy} onClick={() => setDeleting({ kind: 'source', id: String(source.id) })}>删除服务</button></div>{data.providers.filter((model) => model.provider_source_id === source.id).map(modelCard)}</section>)}</div>{data.providers.filter((model) => !model.provider_source_id).length > 0 && <section className="provider-source"><h2>独立模型配置</h2>{data.providers.filter((model) => !model.provider_source_id).map(modelCard)}</section>}{!data.sources.length && !data.providers.length && <p className="field-help">还没有模型线路，从添加服务开始。</p>}</>}
    {editing && <Dialog title={editing.kind === 'source' ? editing.id ? '编辑服务' : '添加服务' : editing.id ? '编辑模型' : '添加模型'} onClose={() => { if (!busy) setEditing(undefined); }}><form onSubmit={(event) => void save(event)}>{dialogError && <p className="message-error" role="alert">{dialogError}</p>}{editing.kind === 'source' && !editing.id && <label className="dialog-field">协议<select aria-label="协议" value={editing.template} disabled={busy} onChange={(event) => { const template = templates.find(([name]) => name === event.target.value); if (template) { setInvalid({}); setEditing({ ...editing, template: template[0], config: structuredClone(template[1]), secrets: [] }); } }}>{templates.map(([name]) => <option key={name} value={name}>{name}</option>)}</select></label>}
      {editing.kind === 'provider' && editing.sourceId && <div className="model-fetch"><button type="button" className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); setDialogError(''); try { setModels(await providersApi.fetchSourceModels(editing.sourceId!)); } catch (reason) { setDialogError(safeError(reason)); } finally { setBusy(false); } }}>拉取模型列表</button>{models.length > 0 && <label className="dialog-field">可用模型<select aria-label="可用模型" value="" onChange={(event) => { if (event.target.value) setEditing({ ...editing, config: { ...editing.config, model: event.target.value, id: editing.config.id || event.target.value } }); }}><option value="">选择模型…</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}</div>}
      <SchemaForm key={editing.template + (editing.id || editing.sourceId || editing.kind)} value={editing.config} fields={fields} secretPaths={editing.secrets} disabled={busy} locked={editing.id ? ['id'] : []} onChange={(config) => setEditing({ ...editing, config })} onValidity={(path, valid) => setInvalid((old) => ({ ...old, [path]: !valid }))} />
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button><button type="submit" className="primary-button" disabled={busy || Object.values(invalid).some(Boolean)}>{busy ? '正在保存…' : '保存线路'}</button></div></form></Dialog>}
    {deleting && <Dialog title={deleting.kind === 'source' ? '删除服务？' : '删除模型？'} onClose={() => { if (!busy) setDeleting(undefined); }}><p className="dialog-description">删除「{deleting.id}」{deleting.kind === 'source' ? '及其关联模型配置' : '的模型配置'}。聊天记录仍保留，使用这条线路的会话需要重新选择模型。</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => { const target = deleting; setDeleting(undefined); void operation(() => target.kind === 'source' ? providersApi.deleteProviderSource(target.id) : providersApi.deleteProvider(target.id), '配置已删除。'); }}>确认删除</button></div></Dialog>}
  </main>;
}
