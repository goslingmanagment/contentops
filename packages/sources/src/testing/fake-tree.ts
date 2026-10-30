import { createHash } from 'node:crypto'
import { dropboxContentHash } from '../hashes.ts'

/**
 * In-memory folder tree behind the fake Yandex Disk and Dropbox servers. Paths are
 * `/A/b.mp4` (no `disk:`), stored raw; lookups are exact (Yandex) or case-insensitive
 * (Dropbox, like `path_lower`). Every change is logged with a sequence number so the fake
 * Dropbox can answer cursors.
 */

export interface FakeNode {
  id: string
  path: string
  name: string
  isDir: boolean
  bytes: Buffer | null
  /** Bumps on every new content; Dropbox `rev`, Yandex `revision`. */
  rev: string
  created: Date
  modified: Date
  clientModified: Date
  shotAt: Date | null
  mediaType: string | null
  mimeType: string | null
}

export interface FileOptions {
  created?: Date
  modified?: Date
  shotAt?: Date | null
  mediaType?: string | null
  mimeType?: string | null
}

export interface Change {
  seq: number
  /** Lookup key of the path that changed (lower-cased in a case-insensitive tree). */
  key: string
}

/** Deterministic bytes without people in them: a SHA-256 counter stream from a seed. */
export function fakeBytes(size: number, seed = 'seed'): Buffer {
  const out = Buffer.alloc(size)
  let pos = 0
  for (let i = 0; pos < size; i++) {
    const block = createHash('sha256').update(`${seed}:${i}`).digest()
    pos += block.copy(out, pos)
  }
  return out
}

const MEDIA: Record<string, [string, string]> = {
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  heic: ['image', 'image/heic'],
  png: ['image', 'image/png'],
  mp4: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  zip: ['compressed', 'application/zip'],
  txt: ['text', 'text/plain'],
}

function guessMedia(name: string): [string | null, string | null] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MEDIA[ext] ?? [null, null]
}

export class FakeTree {
  readonly caseInsensitive: boolean
  readonly idPrefix: string
  readonly #nodes = new Map<string, FakeNode>()
  readonly #byId = new Map<string, FakeNode>()
  /** Old revisions' bytes by rev (Dropbox `rev:` downloads). */
  readonly revisions = new Map<string, { node: FakeNode; bytes: Buffer; modified: Date }>()
  readonly changes: Change[] = []
  #seq = 0
  #ids = 0
  #revs = 0
  /** Advances one second per change so that times are distinct and ordered. */
  #clock: number

  constructor(o: { caseInsensitive?: boolean; idPrefix?: string; start?: Date } = {}) {
    this.caseInsensitive = o.caseInsensitive ?? false
    this.idPrefix = o.idPrefix ?? 'res-'
    this.#clock = (o.start ?? new Date('2026-10-01T10:00:00Z')).getTime()
    this.#put(this.#node('/', '', true))
  }

  get seq(): number {
    return this.#seq
  }

  key(path: string): string {
    const norm = normalize(path).normalize('NFC')
    return this.caseInsensitive ? norm.toLowerCase() : norm
  }

  get(path: string): FakeNode | undefined {
    return this.#nodes.get(this.key(path))
  }

  getById(id: string): FakeNode | undefined {
    return this.#byId.get(id)
  }

  /** Direct children sorted by name, like the APIs return them. */
  children(path: string): FakeNode[] {
    const parent = this.key(path)
    const prefix = parent === '/' ? '/' : `${parent}/`
    return [...this.#nodes.entries()]
      .filter(([k]) => k !== '/' && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map(([, n]) => n)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** Everything under a folder (not the folder itself), parents before children. */
  descendants(path: string): FakeNode[] {
    const parent = this.key(path)
    const prefix = parent === '/' ? '/' : `${parent}/`
    return [...this.#nodes.entries()]
      .filter(([k]) => k !== '/' && k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, n]) => n)
  }

  files(): FakeNode[] {
    return [...this.#nodes.values()].filter((n) => !n.isDir)
  }

  usedBytes(): number {
    return this.files().reduce((s, n) => s + (n.bytes?.length ?? 0), 0)
  }

  addFolder(path: string): FakeNode {
    const p = normalize(path)
    const existing = this.get(p)
    if (existing) return existing
    this.#ensureParents(p)
    return this.#put(this.#node(p, baseName(p), true))
  }

  addFile(path: string, content: Buffer | number, o: FileOptions = {}): FakeNode {
    const p = normalize(path)
    if (this.get(p)) throw new Error(`fake tree: ${p} exists; use replace()`)
    this.#ensureParents(p)
    const node = this.#node(p, baseName(p), false)
    node.bytes = typeof content === 'number' ? fakeBytes(content, p) : content
    const [mediaType, mimeType] = guessMedia(node.name)
    node.mediaType = o.mediaType === undefined ? mediaType : o.mediaType
    node.mimeType = o.mimeType === undefined ? mimeType : o.mimeType
    node.shotAt = o.shotAt ?? null
    if (o.created) node.created = o.created
    if (o.modified) node.modified = node.clientModified = o.modified
    this.#rememberRevision(node)
    return this.#put(node)
  }

  /** New content under the same id: a new revision. */
  replace(path: string, content: Buffer | number): FakeNode {
    const node = this.#must(path)
    node.bytes =
      typeof content === 'number' ? fakeBytes(content, `${node.path}:${this.#revs}`) : content
    node.rev = this.#nextRev()
    node.modified = node.clientModified = this.#tick()
    this.#rememberRevision(node)
    this.#log(node.path)
    return node
  }

  /** Rename or move, keeping the id (and every id below a moved folder). */
  move(from: string, to: string): FakeNode {
    const node = this.#must(from)
    const target = normalize(to)
    this.#ensureParents(target)
    const moved = [node, ...(node.isDir ? this.descendants(node.path) : [])]
    const oldPrefix = node.path
    for (const n of moved) {
      this.#nodes.delete(this.key(n.path))
      this.#log(n.path)
      n.path = target + n.path.slice(oldPrefix.length)
      n.name = baseName(n.path)
      this.#nodes.set(this.key(n.path), n)
      this.#log(n.path)
    }
    return node
  }

  remove(path: string): void {
    const node = this.#must(path)
    for (const n of [node, ...(node.isDir ? this.descendants(node.path) : [])]) {
      this.#nodes.delete(this.key(n.path))
      this.#byId.delete(n.id)
      this.#log(n.path)
    }
  }

  /** Changes after `seq` under `prefix` (lookup keys), oldest first, one per path. */
  changesSince(seq: number, prefixKey: string): Change[] {
    const latest = new Map<string, Change>()
    for (const c of this.changes) {
      if (c.seq <= seq) continue
      const inside = prefixKey === '/' || c.key === prefixKey || c.key.startsWith(`${prefixKey}/`)
      if (inside) {
        latest.delete(c.key)
        latest.set(c.key, c)
      }
    }
    return [...latest.values()]
  }

  #must(path: string): FakeNode {
    const node = this.get(path)
    if (!node) throw new Error(`fake tree: no ${path}`)
    return node
  }

  #ensureParents(path: string): void {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`
      if (!this.get(p)) this.#put(this.#node(p, parts[i - 1] as string, true))
    }
  }

  #node(path: string, name: string, isDir: boolean): FakeNode {
    const t = this.#tick()
    return {
      id: `${this.idPrefix}${(++this.#ids).toString(36).padStart(6, '0')}`,
      path,
      name,
      isDir,
      bytes: null,
      rev: this.#nextRev(),
      created: t,
      modified: t,
      clientModified: t,
      shotAt: null,
      mediaType: null,
      mimeType: null,
    }
  }

  #put(node: FakeNode): FakeNode {
    this.#nodes.set(this.key(node.path), node)
    this.#byId.set(node.id, node)
    if (node.path !== '/') this.#log(node.path)
    return node
  }

  #rememberRevision(node: FakeNode): void {
    if (node.bytes)
      this.revisions.set(node.rev, { node, bytes: node.bytes, modified: node.modified })
  }

  #log(path: string): void {
    this.changes.push({ seq: ++this.#seq, key: this.key(path) })
  }

  #nextRev(): string {
    return (0x15a0000000 + ++this.#revs).toString(16)
  }

  #tick(): Date {
    this.#clock += 1000
    return new Date(this.#clock)
  }
}

function normalize(path: string): string {
  const p = path.startsWith('disk:') ? path.slice(5) : path
  const parts = p.split('/').filter(Boolean)
  return `/${parts.join('/')}`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function md5Hex(b: Buffer): string {
  return createHash('md5').update(b).digest('hex')
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

export { dropboxContentHash }
