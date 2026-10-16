import { apiJson, jsonBody } from './apiClient'

/**
 * The organisation's dictionary: the words the memo editor's spell check
 * should not flag.
 *
 * Two views. What the editor is handed - every word, including every word
 * of every colleague's and department's name, read from the directory -
 * and what an administrator keeps, which is the list of words somebody
 * added, with who and when.
 */

export interface DictionaryWord {
  id: string
  word: string
  createdAt: string
  addedBy: { firstName: string; lastName: string } | null
}

/** For the editor: the words, and nothing else. */
export async function fetchDictionaryWords(): Promise<string[]> {
  const { words } = await apiJson<{ words: string[] }>('/api/memo-dictionary')
  return words
}

export async function fetchMemoDictionary(): Promise<{ words: DictionaryWord[] }> {
  return apiJson<{ words: DictionaryWord[] }>('/api/admin/memo-dictionary')
}

export async function addMemoDictionaryWord(word: string): Promise<{ word: DictionaryWord }> {
  return apiJson<{ word: DictionaryWord }>('/api/admin/memo-dictionary', {
    method: 'POST',
    ...jsonBody({ word }),
  })
}

export async function removeMemoDictionaryWord(id: string): Promise<{ word: DictionaryWord }> {
  return apiJson<{ word: DictionaryWord }>(`/api/admin/memo-dictionary/${id}`, {
    method: 'DELETE',
  })
}
