import { createHash, type Hash } from 'node:crypto'

/** Dropbox `content_hash` block: 4 MiB. */
export const DROPBOX_BLOCK_SIZE = 4 * 1024 * 1024

/**
 * Dropbox `content_hash`, streaming: SHA-256 of each 4 MiB block, then SHA-256 of the
 * concatenated block digests (hex). Chunk boundaries of the input do not matter.
 */
export class DropboxContentHasher {
  readonly #overall = createHash('sha256')
  #block: Hash = createHash('sha256')
  #inBlock = 0

  update(chunk: Uint8Array): this {
    let pos = 0
    while (pos < chunk.length) {
      const take = Math.min(DROPBOX_BLOCK_SIZE - this.#inBlock, chunk.length - pos)
      this.#block.update(chunk.subarray(pos, pos + take))
      this.#inBlock += take
      pos += take
      if (this.#inBlock === DROPBOX_BLOCK_SIZE) this.#flush()
    }
    return this
  }

  digest(): string {
    if (this.#inBlock > 0) this.#flush()
    return this.#overall.digest('hex')
  }

  #flush(): void {
    this.#overall.update(this.#block.digest())
    this.#block = createHash('sha256')
    this.#inBlock = 0
  }
}

export function dropboxContentHash(data: Uint8Array): string {
  return new DropboxContentHasher().update(data).digest()
}

/** The digests the download helper computes in one pass over the bytes. */
export interface Digests {
  sha256: string
  md5: string | null
  contentHash: string | null
}

export class DigestSet {
  readonly #sha256 = createHash('sha256')
  readonly #md5: Hash | null
  readonly #dropbox: DropboxContentHasher | null

  constructor(want: { md5: boolean; contentHash: boolean }) {
    this.#md5 = want.md5 ? createHash('md5') : null
    this.#dropbox = want.contentHash ? new DropboxContentHasher() : null
  }

  update(chunk: Uint8Array): void {
    this.#sha256.update(chunk)
    this.#md5?.update(chunk)
    this.#dropbox?.update(chunk)
  }

  digest(): Digests {
    return {
      sha256: this.#sha256.digest('hex'),
      md5: this.#md5?.digest('hex') ?? null,
      contentHash: this.#dropbox?.digest() ?? null,
    }
  }
}
