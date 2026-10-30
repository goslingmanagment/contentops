import { describe, expect, it } from 'vitest'
import { readZipToc, ZipTocError } from './zip-toc'

/** The table of contents of hand-built archives: only the end and the central directory. */

const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff])
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
const u64 = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

interface Entry {
  name: Buffer
  flags?: number
  size: number
  crc?: number
  time?: number
  date?: number
  extra?: Buffer
}

function central(entry: Entry): Buffer {
  const extra = entry.extra ?? Buffer.alloc(0)
  return Buffer.concat([
    u32(0x02014b50),
    u16(45),
    u16(45),
    u16(entry.flags ?? 0),
    u16(0),
    u16(entry.time ?? 0),
    u16(entry.date ?? 0),
    u32(entry.crc ?? 0x1234abcd),
    u32(Math.min(entry.size, 0xffffffff)),
    u32(Math.min(entry.size, 0xffffffff)),
    u16(entry.name.length),
    u16(extra.length),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    entry.name,
    extra,
  ])
}

/** `stub` bytes of «member data» (or a self-extractor), the directory, the end records. */
function archive(
  entries: Entry[],
  o: { stub?: number; zip64?: boolean; shiftOffsets?: number } = {},
) {
  const stub = Buffer.alloc(o.stub ?? 100, 7)
  const directory = Buffer.concat(entries.map(central))
  // Offsets are as the writer saw them: a stub prepended later is not counted.
  const offset = stub.length - (o.shiftOffsets ?? 0)
  const parts = [stub, directory]
  if (o.zip64) {
    const record = stub.length + directory.length
    parts.push(
      Buffer.concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(entries.length),
        u64(entries.length),
        u64(directory.length),
        u64(offset),
      ]),
      Buffer.concat([u32(0x07064b50), u32(0), u64(record), u32(1)]),
    )
  }
  parts.push(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(o.zip64 ? 0xffff : entries.length),
      u16(o.zip64 ? 0xffff : entries.length),
      u32(o.zip64 ? 0xffffffff : directory.length),
      u32(o.zip64 ? 0xffffffff : offset),
      u16(3),
      Buffer.from('end'),
    ]),
  )
  return Buffer.concat(parts)
}

function reader(bytes: Buffer) {
  const reads: [number, number][] = []
  const read = async (start: number, length: number) => {
    reads.push([start, length])
    return bytes.subarray(start, start + length)
  }
  return { read, reads }
}

const MOSCOW = 'Europe/Moscow'

describe('readZipToc', () => {
  it('reads ZIP64 sizes, CP866 names without a flag and folders', async () => {
    const big = 5 * 1024 ** 3
    const zip64Extra = Buffer.concat([u16(0x0001), u16(16), u64(big), u64(big)])
    // «Пак» in CP866 — what Windows Explorer writes on a Russian system.
    const folder = Buffer.from([0x8f, 0xa0, 0xaa, 0x2f])
    const file = Buffer.concat([folder, Buffer.from('01.mp4')])
    const bytes = archive(
      [
        { name: folder, size: 0 },
        { name: file, size: big, extra: zip64Extra },
        { name: Buffer.from('Сет/02.jpg'), flags: 0x0800, size: 10 },
      ],
      { zip64: true },
    )
    const { read, reads } = reader(bytes)
    const members = await readZipToc(bytes.length, read, MOSCOW)
    expect(members.map((m) => [m.no, m.name, m.isDir, m.size])).toEqual([
      [0, 'Пак', true, 0],
      [1, 'Пак/01.mp4', false, big],
      [2, 'Сет/02.jpg', false, 10],
    ])
    expect(reads).toEqual([[0, bytes.length]])
  })

  it('finds the directory behind a prepended stub and outside the tail', async () => {
    const entries = Array.from({ length: 1500 }, (_, n) => ({
      name: Buffer.from(`folder/${String(n).padStart(4, '0')}-${'x'.repeat(40)}.jpg`),
      size: n,
      // 2026-10-30 12:00:00, local time of whoever packed it.
      date: ((2026 - 1980) << 9) | (10 << 5) | 30,
      time: 12 << 11,
    }))
    const bytes = archive(entries, { stub: 200_000, shiftOffsets: 4096 })
    const { read, reads } = reader(bytes)
    const members = await readZipToc(bytes.length, read, MOSCOW)
    expect(members).toHaveLength(1500)
    expect(members[1499]).toMatchObject({ no: 1499, size: 1499, crc32: 0x1234abcd })
    expect(members[0]?.modifiedAt).toBe('2026-10-30T09:00:00.000Z')
    // The tail, then the directory: no member byte is read.
    expect(reads).toHaveLength(2)
    expect(reads[1]?.[0]).toBe(200_000)
  })

  it('a timestamp extra field wins over the DOS time', async () => {
    const at = Date.UTC(2026, 9, 1, 8, 30) / 1000
    const extra = Buffer.concat([u16(0x5455), u16(5), Buffer.from([1]), u32(at)])
    const bytes = archive([{ name: Buffer.from('a.jpg'), size: 1, date: 0x21, extra }])
    const [member] = await readZipToc(bytes.length, reader(bytes).read, MOSCOW)
    expect(member?.modifiedAt).toBe('2026-10-01T08:30:00.000Z')
  })

  it('a file that is not a ZIP or has a broken directory is refused with a reason', async () => {
    const noise = Buffer.alloc(5000, 3)
    await expect(readZipToc(noise.length, reader(noise).read, MOSCOW)).rejects.toEqual(
      new ZipTocError('not_zip'),
    )
    const good = archive([{ name: Buffer.from('a.jpg'), size: 1 }])
    const broken = Buffer.from(good)
    broken.writeUInt32LE(0, 100) // the first directory record loses its signature
    await expect(readZipToc(broken.length, reader(broken).read, MOSCOW)).rejects.toMatchObject({
      reason: 'bad_central_directory',
    })
  })
})
