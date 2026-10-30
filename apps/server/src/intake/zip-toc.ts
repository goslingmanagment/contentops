import { crc32 } from 'node:zlib'

/**
 * The table of contents of a ZIP without unpacking it (SPEC §6.3: «оглавления архивов
 * читаются в проходе, без распаковки»): the end record and the central directory are read
 * with two ranged reads at most — the tail of the file and, when it does not hold it, the
 * central directory. No member byte is read. ZIP64 and archives with data in front (a
 * self-extracting stub) are understood; split archives are not.
 */

export interface ZipMember {
  /** Position in the central directory from 0: the member's identity (schema §9.7). */
  no: number
  /** Path inside the archive with `/` separators, without a trailing slash for folders. */
  name: string
  isDir: boolean
  size: number
  compressedSize: number
  /** CRC-32 of the uncompressed bytes as the archive records it. */
  crc32: number
  encrypted: boolean
  /** UTC from the timestamp extra fields; else the DOS time read in the model's zone. */
  modifiedAt: string | null
}

/** Why a ZIP's table of contents could not be read; the case says it to a person. */
export class ZipTocError extends Error {
  constructor(readonly reason: string) {
    super(`zip: ${reason}`)
    this.name = 'ZipTocError'
  }
}

/** Reads `length` bytes from `start` of the archive (an HTTP Range). */
export type RangeReader = (start: number, length: number) => Promise<Buffer>

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL = 0x02014b50
const MAX16 = 0xffff
const MAX32 = 0xffffffff
/** The end record, its longest comment, the ZIP64 locator and the ZIP64 end record. */
const TAIL = 22 + MAX16 + 20 + 56
/** A central directory larger than this is not believed (millions of entries). */
const MAX_CENTRAL = 512 * 1024 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true })
/** Windows writes names in the OEM code page without a flag; for this agency it is CP866. */
const oem = new TextDecoder('ibm866')

function big(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipTocError('size_out_of_range')
  return Number(value)
}

export async function readZipToc(
  size: number,
  read: RangeReader,
  timezone: string,
): Promise<ZipMember[]> {
  if (size < 22) throw new ZipTocError('not_zip')
  const tailStart = Math.max(0, size - TAIL)
  const tail = await read(tailStart, size - tailStart)
  if (tail.length !== size - tailStart) throw new ZipTocError('short_read')

  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      at = i
      break
    }
  }
  if (at < 0) throw new ZipTocError('not_zip')
  let disk = tail.readUInt16LE(at + 4)
  let centralDisk = tail.readUInt16LE(at + 6)
  let count = tail.readUInt16LE(at + 10)
  let centralSize = tail.readUInt32LE(at + 12)
  let centralOffset = tail.readUInt32LE(at + 16)
  let endOfCentral = tailStart + at
  let zip64 = false

  if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR) {
    const recordAt = big(tail.readBigUInt64LE(at - 20 + 8))
    const record =
      recordAt >= tailStart && recordAt + 56 <= tailStart + tail.length
        ? tail.subarray(recordAt - tailStart, recordAt - tailStart + 56)
        : await read(recordAt, 56)
    if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD) {
      throw new ZipTocError('bad_zip64_end')
    }
    zip64 = true
    disk = record.readUInt32LE(16)
    centralDisk = record.readUInt32LE(20)
    count = big(record.readBigUInt64LE(32))
    centralSize = big(record.readBigUInt64LE(40))
    centralOffset = big(record.readBigUInt64LE(48))
    endOfCentral = recordAt
  } else if (centralSize === MAX32 || centralOffset === MAX32) {
    throw new ZipTocError('bad_zip64_end')
  }
  if (disk !== 0 || centralDisk !== 0) throw new ZipTocError('multi_volume')
  if (centralSize > MAX_CENTRAL || centralSize > endOfCentral) {
    throw new ZipTocError('bad_central_directory')
  }
  // Data in front of the archive shifts every offset by the same amount.
  const shift = endOfCentral - (centralOffset + centralSize)
  if (shift < 0) throw new ZipTocError('bad_central_directory')
  const centralStart = centralOffset + shift
  const central =
    centralStart >= tailStart
      ? tail.subarray(centralStart - tailStart, centralStart - tailStart + centralSize)
      : await read(centralStart, centralSize)
  if (central.length !== centralSize) throw new ZipTocError('short_read')

  const members = parseCentral(central, timezone)
  // Without ZIP64 the count is 16-bit: writers that ignore the limit let it wrap.
  const counted = zip64 ? members.length : members.length % 0x10000
  if (counted !== count) throw new ZipTocError('entry_count_mismatch')
  return members
}

function parseCentral(central: Buffer, timezone: string): ZipMember[] {
  const members: ZipMember[] = []
  let pos = 0
  while (pos < central.length) {
    if (pos + 46 > central.length || central.readUInt32LE(pos) !== CENTRAL) {
      throw new ZipTocError('bad_central_directory')
    }
    const flags = central.readUInt16LE(pos + 8)
    const time = central.readUInt16LE(pos + 12)
    const date = central.readUInt16LE(pos + 14)
    const crc = central.readUInt32LE(pos + 16)
    let compressedSize = central.readUInt32LE(pos + 20)
    let size = central.readUInt32LE(pos + 24)
    const nameLength = central.readUInt16LE(pos + 28)
    const extraLength = central.readUInt16LE(pos + 30)
    const commentLength = central.readUInt16LE(pos + 32)
    const end = pos + 46 + nameLength + extraLength + commentLength
    if (end > central.length) throw new ZipTocError('bad_central_directory')
    const rawName = central.subarray(pos + 46, pos + 46 + nameLength)
    const extra = central.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength)
    let unicodeName: string | null = null
    let modifiedAt: string | null = null
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e)
      const length = extra.readUInt16LE(e + 2)
      const body = extra.subarray(e + 4, e + 4 + length)
      e += 4 + length
      if (id === 0x0001) {
        // ZIP64: only the fields that are saturated above follow, in this order.
        let f = 0
        const next = () => {
          if (f + 8 > body.length) throw new ZipTocError('bad_zip64_extra')
          const value = big(body.readBigUInt64LE(f))
          f += 8
          return value
        }
        if (size === MAX32) size = next()
        if (compressedSize === MAX32) compressedSize = next()
      } else if (id === 0x7075 && body.length > 5 && body[0] === 1) {
        // Info-ZIP Unicode path: valid while it was made for this very name.
        if (body.readUInt32LE(1) === crc32(rawName)) {
          unicodeName = body.subarray(5).toString('utf8')
        }
      } else if (id === 0x5455 && body.length >= 5 && (body[0] ?? 0) & 1) {
        modifiedAt = new Date(body.readUInt32LE(1) * 1000).toISOString()
      } else if (id === 0x000a && modifiedAt === null && body.length >= 32) {
        // NTFS: tag 1 holds mtime, atime, ctime as FILETIME (100 ns since 1601).
        if (body.readUInt16LE(4) === 1 && body.readUInt16LE(6) >= 24) {
          const ticks = body.readBigUInt64LE(8)
          const ms = Number(ticks / 10_000n) - 11_644_473_600_000
          if (ms > 0) modifiedAt = new Date(ms).toISOString()
        }
      }
    }
    let name = unicodeName ?? decodeName(rawName, (flags & 0x0800) !== 0)
    name = name.replaceAll('\\', '/')
    const isDir = name.endsWith('/')
    if (isDir) name = name.replace(/\/+$/, '')
    members.push({
      no: members.length,
      name,
      isDir,
      size: isDir ? 0 : size,
      compressedSize,
      crc32: crc,
      encrypted: (flags & 1) !== 0,
      modifiedAt: modifiedAt ?? dosTime(date, time, timezone),
    })
    pos = end
  }
  return members
}

function decodeName(raw: Buffer, isUtf8: boolean): string {
  if (isUtf8) return raw.toString('utf8')
  try {
    // macOS and most tools write UTF-8 without setting the flag.
    return utf8.decode(raw)
  } catch {
    return oem.decode(raw)
  }
}

/** DOS date and time are local to whoever packed the archive: read in the model's zone. */
function dosTime(date: number, time: number, timezone: string): string | null {
  const day = date & 0x1f
  const month = (date >> 5) & 0x0f
  if (day === 0 || month === 0 || month > 12) return null
  const wall = Date.UTC(
    1980 + (date >> 9),
    month - 1,
    day,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  )
  let utc = wall - zoneOffset(wall, timezone)
  utc = wall - zoneOffset(utc, timezone)
  return new Date(utc).toISOString()
}

/** Offset of the zone at an instant, in ms (Moscow: +3 h). */
function zoneOffset(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return local - Math.floor(at / 1000) * 1000
}
