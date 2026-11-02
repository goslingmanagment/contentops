/**
 * SHA-256 по кускам (FIPS 180-4): поиск по файлу (DESIGN §4.7) считает хэш потоком, а
 * `crypto.subtle.digest` берёт только весь файл в памяти — у мастера это гигабайт.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private filled = 0
  private length = 0

  update(data: Uint8Array): this {
    this.length += data.length
    this.absorb(data)
    return this
  }

  /** Хэш строкой из 64 шестнадцатеричных знаков; объект после этого не годится. */
  hex(): string {
    const bits = this.length * 8
    const padding = new Uint8Array(this.filled < 56 ? 64 - this.filled : 128 - this.filled)
    padding[0] = 0x80
    const view = new DataView(padding.buffer)
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000))
    view.setUint32(padding.length - 4, bits >>> 0)
    this.absorb(padding)
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('')
  }

  private absorb(data: Uint8Array) {
    let offset = 0
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length)
      this.block.set(data.subarray(0, take), this.filled)
      this.filled += take
      offset = take
      if (this.filled < 64) return
      this.compress(this.block, 0)
      this.filled = 0
    }
    for (; offset + 64 <= data.length; offset += 64) this.compress(data, offset)
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0)
      this.filled = data.length - offset
    }
  }

  private compress(data: Uint8Array, offset: number) {
    const w = this.words
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        ((data[j] as number) << 24) |
        ((data[j + 1] as number) << 16) |
        ((data[j + 2] as number) << 8) |
        (data[j + 3] as number)
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number
      const y = w[i - 2] as number
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }
    const h = this.state
    let a = h[0] as number
    let b = h[1] as number
    let c = h[2] as number
    let d = h[3] as number
    let e = h[4] as number
    let f = h[5] as number
    let g = h[6] as number
    let k = h[7] as number
    for (let i = 0; i < 64; i++) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K[i] as number) +
          (w[i] as number)) |
        0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] as number) + a
    h[1] = (h[1] as number) + b
    h[2] = (h[2] as number) + c
    h[3] = (h[3] as number) + d
    h[4] = (h[4] as number) + e
    h[5] = (h[5] as number) + f
    h[6] = (h[6] as number) + g
    h[7] = (h[7] as number) + k
  }
}

/** Куски, которыми читается файл: доля в строке поиска двигается, память не растёт. */
export const HASH_CHUNK_BYTES = 8 * 1024 * 1024

/** Хэш файла по кускам; `onProgress` — доля от 0 до 1. */
export async function sha256OfFile(
  file: Blob,
  onProgress: (share: number) => void = () => {},
): Promise<string> {
  const hash = new Sha256()
  if (file.size === 0) return hash.hex()
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    const chunk = new Uint8Array(await file.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer())
    hash.update(chunk)
    onProgress(Math.min(1, (offset + chunk.length) / file.size))
  }
  return hash.hex()
}
