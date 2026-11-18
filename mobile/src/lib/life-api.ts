import { chatRequest } from './api';

export type LifeCategory = 'board' | 'diary' | 'expense' | 'diet' | 'cycle' | 'daily' | 'memo' | 'anniversary';
export type LifeWrite = { category: LifeCategory; text: string; ai_visible: boolean; day: string; parent_id: string | null };
export type LifeEntry = LifeWrite & { id: string; author: 'user' | 'ai'; created_at: string };
type LifeUpdate = Partial<Pick<LifeWrite, 'text' | 'day' | 'ai_visible'>>;

function entriesPath(persona: string, id?: string) {
  return '/tillith/life/' + encodeURIComponent(persona) + '/entries' + (id ? '/' + encodeURIComponent(id) : '');
}

export async function listLifeEntries(persona: string): Promise<LifeEntry[]> {
  return (await chatRequest(entriesPath(persona))).items;
}

export function createLifeEntry(persona: string, value: LifeWrite): Promise<LifeEntry> {
  if (value.category === 'diary' && !value.ai_visible) throw new Error('本机日记请保存到当前设备。');
  return chatRequest(entriesPath(persona), { method: 'POST', body: JSON.stringify(value) });
}

export function updateLifeEntry(persona: string, id: string, value: LifeUpdate): Promise<LifeEntry> {
  return chatRequest(entriesPath(persona, id), { method: 'PATCH', body: JSON.stringify(value) });
}

export async function deleteLifeEntry(persona: string, id: string): Promise<void> {
  await chatRequest(entriesPath(persona, id), { method: 'DELETE' });
}
