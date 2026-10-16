/**
 * A random id for something on screen - a routing step being edited, say.
 *
 * `crypto.randomUUID()` exists only on a secure page: https, or localhost.
 * Opened the way this office opens it - plain http by the server's name,
 * `http://ids-it-shahzad:5173` - the browser leaves it undefined, and the
 * submit screen crashed the moment it made its first approval step.
 * `crypto.getRandomValues` has no such restriction, so the same version-4
 * UUID is built from it when the short way is not there.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
