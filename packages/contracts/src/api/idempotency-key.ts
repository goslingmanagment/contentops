/**
 * A new `Idempotency-Key` for every intent of a person (DESIGN §3.8). The same key is
 * sent again only by an automatic retry or «Повторить» after an error.
 */
export function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
