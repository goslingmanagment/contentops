/** Header names of the API contract (SPEC §11.2). */
export const HEADER = {
  ifMatch: 'If-Match',
  ifNoneMatch: 'If-None-Match',
  etag: 'ETag',
  idempotencyKey: 'Idempotency-Key',
  retryAfter: 'Retry-After',
  requestId: 'X-Request-Id',
  contentType: 'Content-Type',
} as const

/** Versions travel as quoted ETags: `"12"`. */
export function versionTag(version: number | string): string {
  return `"${version}"`
}

export function parseVersionTag(tag: string | null): string | null {
  if (!tag) return null
  return tag.replace(/^W\//, '').replace(/^"|"$/g, '')
}
