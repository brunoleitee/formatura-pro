import { API_BASE, fetchJSON, post } from './core';
import type { Person, SearchResult } from './types';

export const peopleApi = {
  getPeople: (unknown = false, signal?: AbortSignal) => fetchJSON<Person[]>(`${API_BASE}/people?unknown=${unknown}`, { signal }),
  renamePerson: (old_id: string, new_id: string) => post(`${API_BASE}/rename-person`, { old_id, new_id }),
  deletePerson: (aluno_id: string) => post(`${API_BASE}/delete-person`, { aluno_id }),
  globalSearch: (q: string) => fetchJSON<SearchResult[]>(`${API_BASE}/search/global?q=${encodeURIComponent(q)}`),
};
