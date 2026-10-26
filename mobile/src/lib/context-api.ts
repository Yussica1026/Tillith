import { Capacitor, registerPlugin } from '@capacitor/core';
import { chatRequest, managementRequest } from './api';

export type PersonaOption = { id: string; name: string; folder_id: string | null; sort_order: number; default_config_id?: string | null; default_provider_id?: string | null };
export type PersonaSettings = { persona_id: string; display_name: string; default_config_id: string | null; default_provider_id: string | null };
export type Persona = { persona_id: string; system_prompt: string; begin_dialogs: { role: 'user' | 'assistant'; content: string }[]; folder_id: string | null; sort_order: number };
export type PersonaFolder = { folder_id: string; name: string; parent_id: string | null; description?: string; sort_order: number; children?: PersonaFolder[] };
export type WorldbookEntry = { id?: string; title: string; text: string; enabled: boolean; always_active: boolean; keywords: string[]; regex: boolean; case_sensitive: boolean; scan_depth: number; position: 'before_system' | 'after_system' | 'before_history' | 'after_history'; role: 'system' | 'user' | 'assistant'; priority: number };
export type WorldbookWrite = { name: string; description: string; enabled: boolean; entries: WorldbookEntry[] };
export type Worldbook = WorldbookWrite & { id: string };
export type Memory = { id: string; persona_id: string; type: string; text: string; starred: boolean; trashed: boolean; invalidated: boolean; source_message_id: number | null; created_at: string; updated_at: string };
export type MemoryWrite = Pick<Memory, 'persona_id' | 'type' | 'text' | 'starred'> & { source_message_id?: number };
export type SessionContext = { persona_id: string | null; worldbook_ids: string[]; memory_enabled: boolean; memory_tools_enabled: boolean };
export type ContextSource = { session_id: string; run_id: string; checkpoint_id: string | null; persona_id: string | null; worldbooks: { book_id: string; entry_id: string; title: string; text: string; position: string; role: string }[]; memories: Pick<Memory, 'id' | 'text' | 'type' | 'source_message_id'>[]; memory_tools_enabled: boolean; created_at: string };

export async function listPersonaOptions(): Promise<PersonaOption[]> { return (await chatRequest('/tillith/persona-options')).personas; }
export function getPersonaSettings(id: string): Promise<PersonaSettings> { return chatRequest('/tillith/persona-settings/' + encodeURIComponent(id)); }
export function savePersonaSettings(id: string, value: string | Partial<Omit<PersonaSettings, 'persona_id'>>): Promise<PersonaSettings> { return chatRequest('/tillith/persona-settings/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(typeof value === 'string' ? { display_name: value } : value) }); }
export function listPersonas(): Promise<Persona[]> { return managementRequest('/personas'); }
export function listPersonaFolders(): Promise<PersonaFolder[]> { return managementRequest('/personas/tree'); }
export async function savePersona(value: Pick<Persona, 'persona_id' | 'system_prompt' | 'begin_dialogs'> & { folder_id?: string | null }, existing = false): Promise<void> {
  await managementRequest(existing ? '/personas/by-id' : '/personas', { method: existing ? 'PUT' : 'POST', body: JSON.stringify(value) });
}
export async function deletePersona(id: string): Promise<void> { await managementRequest('/personas/by-id?persona_id=' + encodeURIComponent(id), { method: 'DELETE' }); }
export async function movePersona(id: string, folderId: string | null): Promise<void> { await managementRequest('/personas/move', { method: 'POST', body: JSON.stringify({ persona_id: id, folder_id: folderId }) }); }
export async function pinPersona(id: string, others: Persona[]): Promise<void> {
  const ordered = [...others].sort((a, b) => a.sort_order - b.sort_order).filter(item => item.persona_id !== id);
  await managementRequest('/personas/reorder', { method: 'POST', body: JSON.stringify({ items: [{ id, type: 'persona', sort_order: 0 }, ...ordered.map((item, index) => ({ id: item.persona_id, type: 'persona', sort_order: index + 1 }))] }) });
}
export async function savePersonaFolder(name: string, id?: string, parentId?: string | null): Promise<void> { await managementRequest(id ? '/persona-folders/' + encodeURIComponent(id) : '/persona-folders', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ name, ...(parentId !== undefined ? { parent_id: parentId } : {}) }) }); }
export async function deletePersonaFolder(id: string): Promise<void> { await managementRequest('/persona-folders/' + encodeURIComponent(id), { method: 'DELETE' }); }
export async function listWorldbooks(): Promise<Worldbook[]> { return (await chatRequest('/tillith/worldbooks')).worldbooks; }
export function saveWorldbook(value: WorldbookWrite, id?: string): Promise<Worldbook> { return chatRequest('/tillith/worldbooks' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(value) }); }
export async function deleteWorldbook(id: string): Promise<void> { await chatRequest('/tillith/worldbooks/' + encodeURIComponent(id), { method: 'DELETE' }); }
export async function importWorldbooks(value: unknown): Promise<Worldbook[]> { return (await chatRequest('/tillith/worldbooks/import', { method: 'POST', body: JSON.stringify(value) })).worldbooks; }
export async function exportWorldbook(book: Worldbook): Promise<boolean> {
  const data = await chatRequest('/tillith/worldbooks/' + encodeURIComponent(book.id) + '/export');
  const text = JSON.stringify(data, null, 2), name = (book.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60) || 'Tillith-worldbook') + '.json';
  if (Capacitor.isNativePlatform()) {
    const files = registerPlugin<{ saveText(options: { name: string; text: string }): Promise<{ cancelled?: boolean }> }>('TillithFiles');
    return !(await files.saveText({ name, text })).cancelled;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
export async function listMemories(personaId?: string, query = '', trashed = false): Promise<Memory[]> {
  const params = new URLSearchParams({ q: query, trashed: String(trashed) });
  if (personaId) params.set('persona_id', personaId);
  return (await chatRequest('/tillith/memories?' + params)).memories;
}
export function createMemory(value: MemoryWrite): Promise<Memory> { return chatRequest('/tillith/memories', { method: 'POST', body: JSON.stringify(value) }); }
export function updateMemory(id: string, value: Partial<Pick<Memory, 'type' | 'text' | 'starred' | 'trashed'>>): Promise<Memory> { return chatRequest('/tillith/memories/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(value) }); }
export async function trashMemory(id: string): Promise<void> { await chatRequest('/tillith/memories/' + encodeURIComponent(id), { method: 'DELETE' }); }
export function getSessionContext(sessionId: string): Promise<SessionContext> { return chatRequest('/tillith/sessions/' + encodeURIComponent(sessionId) + '/context'); }
export function updateSessionContext(sessionId: string, value: Partial<SessionContext>): Promise<SessionContext> { return chatRequest('/tillith/sessions/' + encodeURIComponent(sessionId) + '/context', { method: 'PATCH', body: JSON.stringify(value) }); }
export async function listContextSources(sessionId: string, checkpointId?: string, runId?: string): Promise<ContextSource[]> {
  const params = new URLSearchParams(); if (checkpointId) params.set('checkpoint_id', checkpointId); if (runId) params.set('run_id', runId);
  return (await chatRequest('/tillith/sessions/' + encodeURIComponent(sessionId) + '/context-sources?' + params)).sources;
}
