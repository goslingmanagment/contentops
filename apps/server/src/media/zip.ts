import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

/**
 * A stored (uncompressed) ZIP of issued files (SPEC §9.1 «ZIP» in the exports folder): media
 * is already compressed, so «store» keeps the bytes as they are and the archive opens in
 * Finder, Explorer and CapCut's importer alike. ZIP64 records appear when a size or an
 * offset passes 4 GiB. Written under a temp name and renamed when complete.
 */

export interface ZipMember {
  name: string
  path: string
}

const MAX32 = 0xffffffff
const UTF8_FLAG = 0x0800
/** DOS date/time of 1980-01-01 00:00: a fixed stamp keeps two builds of one issue equal. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

async function crcOf(path: string, signal?: AbortSignal): Promise<number> {
  let crc = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20, signal })) {
    crc = crc32(chunk as Buffer, crc)
  }
  return crc
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

export async function writeZip(
  target: string,
  members: readonly ZipMember[],
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  const temp = `${target}.partial`
  const out = createWriteStream(temp)
  let offset = 0
  const write = async (chunk: Buffer) => {
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    offset += chunk.length
  }
  const central: Buffer[] = []
  try {
    for (const member of members) {
      signal?.throwIfAborted()
      const size = (await stat(member.path)).size
      const crc = await crcOf(member.path, signal)
      const name = Buffer.from(member.name, 'utf8')
      const headerOffset = offset
      const zip64 = size >= MAX32 || headerOffset >= MAX32
      const localExtra = zip64
        ? Buffer.concat([u16(0x0001), u16(16), u64(size), u64(size)])
        : Buffer.alloc(0)
      await write(
        Buffer.concat([
          u32(0x04034b50),
          u16(zip64 ? 45 : 20),
          u16(UTF8_FLAG),
          u16(0),
          u16(DOS_TIME),
          u16(DOS_DATE),
          u32(crc),
          u32(zip64 ? MAX32 : size),
          u32(zip64 ? MAX32 : size),
          u16(name.length),
          u16(localExtra.length),
          name,
          localExtra,
        ]),
      )
      for await (const chunk of createReadStream(member.path, { highWaterMark: 1 << 20, signal })) {
        await write(chunk as Buffer)
      }
      const centralExtra = zip64
        ? Buffer.concat([u16(0x0001), u16(24), u64(size), u64(size), u64(headerOffset)])
        : Buffer.alloc(0)
      central.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(zip64 ? 45 : 20),
          u16(zip64 ? 45 : 20),
          u16(UTF8_FLAG),
          u16(0),
          u16(DOS_TIME),
          u16(DOS_DATE),
          u32(crc),
          u32(zip64 ? MAX32 : size),
          u32(zip64 ? MAX32 : size),
          u16(name.length),
          u16(centralExtra.length),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(zip64 ? MAX32 : headerOffset),
          name,
          centralExtra,
        ]),
      )
    }
    const centralOffset = offset
    for (const record of central) await write(record)
    const centralSize = offset - centralOffset
    const count = members.length
    if (centralOffset >= MAX32 || count >= 0xffff) {
      const zip64End = offset
      await write(
        Buffer.concat([
          u32(0x06064b50),
          u64(44),
          u16(45),
          u16(45),
          u32(0),
          u32(0),
          u64(count),
          u64(count),
          u64(centralSize),
          u64(centralOffset),
        ]),
      )
      await write(Buffer.concat([u32(0x07064b50), u32(0), u64(zip64End), u32(1)]))
    }
    await write(
      Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(Math.min(count, 0xffff)),
        u16(Math.min(count, 0xffff)),
        u32(Math.min(centralSize, MAX32)),
        u32(Math.min(centralOffset, MAX32)),
        u16(0),
      ]),
    )
    out.end()
    await finished(out)
    const handle = await open(temp, 'r+')
    await handle.sync()
    await handle.close()
    await rename(temp, target)
    return { bytes: offset }
  } catch (error) {
    out.destroy()
    await rm(temp, { force: true })
    throw error
  }
}
