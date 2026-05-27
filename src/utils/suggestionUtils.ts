export interface SuggestionInfo {
  tier: 'strong' | 'possible' | 'weak' | 'unknown' | 'none';
  label: string;
  student?: string;
  similarity?: number;
  similarNumber?: number;
}

export function getSuggestionInfo(cluster: {
  suggested_student?: string | null;
  suggested_similarity?: number | null;
  best_student_debug?: string | null;
  best_similarity_debug?: number | null;
  unknown_similar_id?: string | null;
  unknown_similar_number?: number | null;
  unknown_similar_similarity?: number | null;
  isAssigned?: boolean;
}): SuggestionInfo {
  const { suggested_student, suggested_similarity, best_student_debug, best_similarity_debug, unknown_similar_id, unknown_similar_number, unknown_similar_similarity, isAssigned } = cluster;

  if (suggested_student && suggested_similarity != null && isFinite(suggested_similarity) && suggested_similarity >= 0.55 && !isAssigned) {
    return { tier: 'strong', label: suggested_student, student: suggested_student, similarity: suggested_similarity };
  }
  if (suggested_student && suggested_similarity != null && isFinite(suggested_similarity) && suggested_similarity >= 0.45 && !isAssigned) {
    return { tier: 'possible', label: suggested_student, student: suggested_student, similarity: suggested_similarity };
  }
  if (best_student_debug && best_similarity_debug != null && isFinite(best_similarity_debug) && best_similarity_debug >= 0.30 && !isAssigned) {
    return { tier: 'weak', label: best_student_debug, student: best_student_debug, similarity: best_similarity_debug };
  }
  if (unknown_similar_id && unknown_similar_number && unknown_similar_similarity != null && isFinite(unknown_similar_similarity) && unknown_similar_similarity >= 0.55 && !isAssigned) {
    return { tier: 'unknown', label: `#${unknown_similar_number}`, similarNumber: unknown_similar_number, similarity: unknown_similar_similarity };
  }
  return { tier: 'none', label: 'Sem match' };
}
