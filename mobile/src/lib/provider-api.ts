import { managementRequest, safeError } from './api';

export type ProviderConfig = Record<string, unknown>;
export type ProviderSchema = { items?: Record<string, unknown>; config_template?: Record<string, ProviderConfig>; [key: string]: unknown };

export async function loadProviderWorkspace(): Promise<{ schema: ProviderSchema; sources: ProviderConfig[]; providers: ProviderConfig[] }> {
  const [schema, sources, providers] = await Promise.all([
    managementRequest('/tillith/providers/schema'),
    managementRequest('/tillith/provider-sources'),
    managementRequest('/tillith/providers'),
  ]);
  return { schema: schema.config_schema.provider, sources: sources.provider_sources, providers: providers.providers };
}

function editable(config: ProviderConfig): ProviderConfig {
  const { secret_fields_present: _secretFields, ...value } = config;
  return value;
}

export function saveProviderSource(config: ProviderConfig, id?: string): Promise<{ id: string }> {
  return managementRequest(id === undefined ? '/tillith/provider-sources' : '/tillith/provider-sources/by-id?source_id=' + encodeURIComponent(id), {
    method: id === undefined ? 'POST' : 'PUT', body: JSON.stringify({ config: editable(config) }),
  });
}

export function saveProvider(config: ProviderConfig, id?: string, sourceId?: string): Promise<{ id: string }> {
  return managementRequest(id === undefined ? '/tillith/providers' : '/tillith/providers/by-id?provider_id=' + encodeURIComponent(id), {
    method: id === undefined ? 'POST' : 'PUT', body: JSON.stringify({ config: editable(config), ...(id === undefined && sourceId ? { source_id: sourceId } : {}) }),
  });
}

export async function deleteProviderSource(id: string): Promise<void> {
  await managementRequest('/tillith/provider-sources/by-id?source_id=' + encodeURIComponent(id), { method: 'DELETE' });
}

export async function deleteProvider(id: string): Promise<void> {
  await managementRequest('/tillith/providers/by-id?provider_id=' + encodeURIComponent(id), { method: 'DELETE' });
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<void> {
  await managementRequest('/tillith/providers/enabled?provider_id=' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
}

export async function fetchSourceModels(id: string): Promise<string[]> {
  const result = await managementRequest('/tillith/provider-sources/models?source_id=' + encodeURIComponent(id));
  return result.models;
}

export async function testProvider(id: string): Promise<{ ok: boolean; message: string }> {
  const result = await managementRequest('/tillith/providers/test?provider_id=' + encodeURIComponent(id), { method: 'POST' });
  return { ok: result.status === 'available', message: result.status === 'available' ? '模型已响应测试请求。' : safeError(result.error || '模型暂时不可用，请检查服务配置。') };
}
