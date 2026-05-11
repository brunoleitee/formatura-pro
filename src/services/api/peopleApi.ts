import { API_BASE, fetchJSON, post } from './core';
import type { Person, SearchResult } from './types';

export const peopleApi = {
  getPeople: (unknown = false, catalog = "") => 
    fetchJSON<Person[]>(`${API_BASE}/people?unknown=${unknown}${catalog ? `&catalog=${encodeURIComponent(catalog)}` : ''}`),
  
  renamePerson: (old_id: string, new_id: string, catalog: string) => 
    post(`${API_BASE}/rename-person`, { old_id, new_id, catalog }),
    
  deletePerson: (aluno_id: string, catalog: string) => 
    post(`${API_BASE}/delete-person`, { aluno_id, catalog }),
    
  globalSearch: (q: string) => 
    fetchJSON<SearchResult[]>(`${API_BASE}/search/global?q=${encodeURIComponent(q)}`),
};
