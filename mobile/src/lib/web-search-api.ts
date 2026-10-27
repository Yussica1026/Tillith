import { managementRequest } from './api';

export type WebSearchProvider = {
  id: string;
  label: string;
  key_kind: 'single' | 'multiple';
  anonymous: boolean;
};

export type WebSearchProfile = {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  show_sources: boolean;
  configured_providers: string[];
};

export type WebSearchWorkspace = {
  profiles: WebSearchProfile[];
  providers: WebSearchProvider[];
};

function profile(value: unknown): WebSearchProfile {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    id: String(row.id || ''),
    name: typeof row.name === 'string' && row.name.trim() ? row.name : String(row.id || '未命名配置'),
    enabled: row.enabled === true,
    provider: typeof row.provider === 'string' ? row.provider : 'tavily',
    show_sources: row.show_sources === true,
    configured_providers: Array.isArray(row.configured_providers) ? row.configured_providers.filter((item): item is string => typeof item === 'string') : [],
  };
}

export async function loadWebSearchProfiles(): Promise<WebSearchWorkspace> {
  const data = await managementRequest('/tillith/web-search-profiles');
  const profiles = Array.isArray(data?.profiles) ? data.profiles.map(profile).filter((item: WebSearchProfile) => item.id) : [];
  const providers = (Array.isArray(data?.providers) ? data.providers : []).flatMap((value: unknown): WebSearchProvider[] => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (typeof row.id !== 'string' || typeof row.label !== 'string') return [];
    return [{ id: row.id, label: row.label, key_kind: row.key_kind === 'single' ? 'single' : 'multiple', anonymous: row.anonymous === true }];
  });
  return { profiles, providers };
}

export async function saveWebSearchProfile(id: string, value: { enabled: boolean; provider: string; show_sources: boolean; api_key?: string | string[]; clear_key?: boolean }): Promise<WebSearchProfile> {
  return profile(await managementRequest('/tillith/web-search-profiles/' + encodeURIComponent(id), {
    method: 'PUT', body: JSON.stringify(value),
  }));
}
