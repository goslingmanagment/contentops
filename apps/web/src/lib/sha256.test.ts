import { describe, expect, it } from 'vitest'
import { HASH_CHUNK_BYTES, Sha256, sha256OfFile } from './sha256'

/** Поиск по файлу сравнивает байты по SHA-256: хэш браузера обязан совпасть с эталоном. */
async function reference(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65_536)))
  }
  return bytes
}

describe('SHA-256 по кускам (DESIGN §4.7)', () => {
  it('совпадает с эталоном на границах блока и пустом входе', async () => {
    for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = randomBytes(size)
      expect(new Sha256().update(bytes).hex(), `size ${size}`).toBe(await reference(bytes))
    }
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('куски любой длины дают тот же хэш, что весь файл разом', async () => {
    const bytes = randomBytes(10_000)
    const hash = new Sha256()
    let offset = 0
    let step = 1
    while (offset < bytes.length) {
      hash.update(bytes.subarray(offset, offset + step))
      offset += step
      step = ((step * 7) % 97) + 1
    }
    expect(hash.hex()).toBe(await reference(bytes))
  })

  it('файл больше одного куска чтения', async () => {
    const bytes = randomBytes(HASH_CHUNK_BYTES + 12_345)
    const shares: number[] = []
    const hex = await sha256OfFile(new Blob([bytes]), (share) => shares.push(share))
    expect(hex).toBe(await reference(bytes))
    expect(shares).toHaveLength(2)
    expect(shares.at(-1)).toBe(1)
  })
})
