import { useEffect, useState } from 'react';

export type FieldSchema = { type?: string; description?: string; hint?: string; secret?: boolean; invisible?: boolean; options?: unknown[]; labels?: string[]; items?: Record<string, FieldSchema>; template_schema?: Record<string, FieldSchema>; condition?: Record<string, unknown>; slider?: { min?: number; max?: number; step?: number } };
export type ConfigValue = Record<string, unknown>;
const labels: Record<string, string> = { id: '名称 / ID', api_base: 'API 地址', key: 'API Key', api_key: 'API Key', model: '模型名称', enable: '启用', timeout: '超时（秒）', proxy: '代理地址', custom_headers: '请求头', custom_extra_body: '模型参数', temperature: 'Temperature · 温度', top_p: 'Top P', max_tokens: '最大输出 Tokens', max_context_tokens: '上下文长度', provider: '服务商', type: '协议类型', provider_type: '模型类型' };
const secretName = (name: string) => /^(key|headers|custom_headers|auth|authorization|cookie)$|api.?key|password|passwd|secret|credential|private.?key|access.?key|(^|_)token($|_)/i.test(name);

function SecretInput({ value, label, configured, disabled, onChange, onValidity }: { value: unknown; label: string; configured: boolean; disabled?: boolean; onChange: (value: unknown) => void; onValidity: (valid: boolean) => void }) {
  const [text, setText] = useState(() => Array.isArray(value) ? value.join('\n') : value && typeof value === 'object' ? Object.keys(value).length ? JSON.stringify(value) : '' : String(value || ''));
  const [error, setError] = useState(false);
  return <><input type="password" aria-label={label} autoComplete="new-password" spellCheck={false} disabled={disabled} value={text} placeholder={configured ? '已配置，留空保留' : '填写密钥'} onChange={(event) => {
    const raw = event.target.value; setText(raw);
    try {
      const next = Array.isArray(value) ? raw ? [raw] : [] : value && typeof value === 'object' ? raw ? JSON.parse(raw) : {} : raw;
      if (value && typeof value === 'object' && !Array.isArray(value) && (!next || typeof next !== 'object' || Array.isArray(next))) throw new Error();
      onChange(next); onValidity(true); setError(false);
    } catch { onValidity(false); setError(true); }
  }} />{error && <span className="message-error">请求头需填写 JSON 对象。</span>}</>;
}

function StructuredInput({ value, onChange, onValidity, label }: { value: unknown; onChange: (value: unknown) => void; onValidity: (valid: boolean) => void; label: string }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState(false);
  useEffect(() => { setText(JSON.stringify(value, null, 2)); setError(false); }, [value]);
  return <><textarea aria-label={label} value={text} rows={4} spellCheck={false} onChange={(event) => {
    const raw = event.target.value; setText(raw);
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(value) ? !Array.isArray(parsed) : !parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
      setError(false); onValidity(true); onChange(parsed);
    } catch { setError(true); onValidity(false); }
  }} />{error && <span className="message-error">请填写有效的 {Array.isArray(value) ? 'JSON 数组' : 'JSON 对象'}。</span>}</>;
}

export function SchemaForm({ value, fields, onChange, onValidity, disabled, secretPaths = [], prefix = '', locked = [] }: { value: ConfigValue; fields: Record<string, FieldSchema>; onChange: (value: ConfigValue) => void; onValidity: (path: string, valid: boolean) => void; disabled?: boolean; secretPaths?: string[]; prefix?: string; locked?: string[] }) {
  return <div className="schema-fields">{Object.entries(value).filter(([name]) => name !== 'secret_fields_present' && !fields[name]?.invisible && !['provider_source_id', 'provider', 'provider_type', 'type'].includes(name)).map(([name, fieldValue]) => {
    const schema = fields[name] || {};
    if (schema.condition && !Object.entries(schema.condition).every(([field, expected]) => value[field] === expected)) return null;
    const path = prefix ? prefix + '.' + name : name;
    const label = labels[name] || (schema.description && !schema.description.includes('.') ? schema.description : name.replace(/_/g, ' '));
    const secret = schema.secret || secretName(name) || secretPaths.includes(path);
    const update = (next: unknown) => onChange({ ...value, [name]: next });
    const childFields = Object.keys(schema.items || {}).length ? schema.items! : schema.template_schema || {};
    if (!secret && fieldValue && typeof fieldValue === 'object' && !Array.isArray(fieldValue) && Object.keys(childFields).length) {
      return <fieldset className="schema-group" key={name}><legend>{label}</legend><SchemaForm value={fieldValue as ConfigValue} fields={childFields} onChange={update} onValidity={onValidity} disabled={disabled} secretPaths={secretPaths} prefix={path} />{schema.template_schema && <label className="dialog-field">添加参数<select aria-label={`添加${label}`} value="" disabled={disabled} onChange={(event) => { if (event.target.value) update({ ...(fieldValue as ConfigValue), [event.target.value]: '' }); }}><option value="">选择参数…</option>{Object.keys(schema.template_schema).filter((key) => !(key in (fieldValue as ConfigValue))).map((key) => <option key={key} value={key}>{labels[key] || key}</option>)}</select></label>}</fieldset>;
    }
    const boolean = schema.type === 'bool' || typeof fieldValue === 'boolean';
    const numeric = ['int', 'float', 'number'].includes(schema.type || '') || typeof fieldValue === 'number';
    return <label className={boolean ? 'toggle-field' : 'dialog-field'} key={name}>
      {!boolean && <span>{label}</span>}
      {secret ? <SecretInput value={fieldValue} label={label} configured={secretPaths.includes(path)} disabled={disabled || locked.includes(name)} onChange={update} onValidity={(valid) => onValidity(path, valid)} />
        : boolean ? <><input type="checkbox" checked={!!fieldValue} disabled={disabled || locked.includes(name)} onChange={(event) => update(event.target.checked)} /><span>{label}</span></>
        : schema.options?.length ? <select aria-label={label} value={String(fieldValue ?? '')} disabled={disabled || locked.includes(name)} onChange={(event) => update(event.target.value)}>{schema.options.map((option, index) => <option key={String(option)} value={String(option)}>{schema.labels?.[index] || String(option)}</option>)}</select>
        : fieldValue && typeof fieldValue === 'object' ? <StructuredInput value={fieldValue} label={label} onChange={update} onValidity={(valid) => onValidity(path, valid)} />
        : <input aria-label={label} type={numeric ? 'number' : 'text'} value={String(fieldValue ?? '')} step={schema.slider?.step ?? (schema.type === 'int' ? 1 : 'any')} min={schema.slider?.min} max={schema.slider?.max} spellCheck={false} autoComplete="off" disabled={disabled || locked.includes(name)} onChange={(event) => { const raw = event.target.value; update(numeric && raw !== '' ? Number(raw) : raw); onValidity(path, !numeric || raw !== '' && Number.isFinite(Number(raw))); }} />}
      {secretPaths.includes(path) && <span className="field-help">凭据已保存在核心。填写新值才会替换。</span>}
    </label>;
  })}</div>;
}
