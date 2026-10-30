import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DROPBOX_BLOCK_SIZE, DropboxContentHasher, dropboxContentHash } from './hashes.ts'
import { fakeBytes } from './testing/index.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest()

describe('Dropbox content_hash', () => {
  it('is SHA-256 over the SHA-256 of each 4 MiB block', () => {
    expect(dropboxContentHash(new Uint8Array())).toBe(createHash('sha256').digest('hex'))
    const small = fakeBytes(1000)
    expect(dropboxContentHash(small)).toBe(createHash('sha256').update(sha(small)).digest('hex'))
    const two = fakeBytes(DROPBOX_BLOCK_SIZE + 7, 'two')
    const expected = createHash('sha256')
      .update(
        Buffer.concat([
          sha(two.subarray(0, DROPBOX_BLOCK_SIZE)),
          sha(two.subarray(DROPBOX_BLOCK_SIZE)),
        ]),
      )
      .digest('hex')
    expect(dropboxContentHash(two)).toBe(expected)
  })

  it('does not depend on how the stream is chunked', () => {
    const data = fakeBytes(2 * DROPBOX_BLOCK_SIZE + 12_345, 'chunks')
    const whole = dropboxContentHash(data)
    for (const step of [1 << 16, 999_983, DROPBOX_BLOCK_SIZE, DROPBOX_BLOCK_SIZE + 1]) {
      const h = new DropboxContentHasher()
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step))
      expect(h.digest()).toBe(whole)
    }
  })
})
