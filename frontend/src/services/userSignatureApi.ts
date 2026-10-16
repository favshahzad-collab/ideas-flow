import { apiFetch, apiVoid } from './apiClient'
import { parseApiError } from '../utils/apiError'

export async function fetchMySignature(): Promise<Blob | null> {
  const res = await apiFetch('/api/users/me/signature')

  // 404 is the normal answer for an account that has not saved one yet.
  if (res.status === 404) {
    return null
  }

  if (!res.ok) {
    throw new Error(await parseApiError(res))
  }

  return res.blob()
}

export async function uploadMySignature(file: File): Promise<void> {
  const formData = new FormData()
  formData.append('file', file)

  await apiVoid('/api/users/me/signature', { method: 'POST', body: formData })
}

export async function deleteMySignature(): Promise<void> {
  await apiVoid('/api/users/me/signature', { method: 'DELETE' })
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read signature image'))
    reader.readAsDataURL(blob)
  })
}
