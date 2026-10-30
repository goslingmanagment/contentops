import { describe, expect, it } from 'vitest'
import { CopyList, parseCopyList } from './copy-list.ts'

const PRESENT = 0x20 | 0x400 | 0x80000 // ARCHIVE | REPARSE_POINT | PINNED
const PLACEHOLDER = 0x20 | 0x200 | 0x400 | 0x1000 | 0x400000 // … | SPARSE | OFFLINE | RECALL

const line = (path: string, size: number, attributes: number, present: boolean) =>
  JSON.stringify({
    path,
    is_dir: false,
    size,
    last_write_utc: '2025-04-05T10:00:00Z',
    attributes,
    bytes_present: present,
  })
const dir = (path: string) =>
  JSON.stringify({
    path,
    is_dir: true,
    size: 0,
    last_write_utc: '2025-04-05T10:00:00Z',
    attributes: 0x10,
    listed: true,
  })

// Fictional copy: names as the client wrote them (`:` → `-`, trailing space → `-`).
const LIST = [
  dir('1. PPV'),
  line('1. PPV/PPV_Тест_3мин_05.04.25.MOV', 1000, PRESENT, true),
  line('1. PPV/архив.zip', 5000, PLACEHOLDER, false),
  dir('3. Customs/Ночь-'),
  line('3. Customs/Ночь-/13-03 хвост .mov', 700, PRESENT, true),
  line(`5. Sextings/${'Ёлка'.normalize('NFD')}.jpg`, 42, PRESENT, true),
  '',
].join('\r\n')

describe('copy list', () => {
  const list = CopyList.parse(LIST)

  it('answers by API path: bytes on disk and size', () => {
    expect(list.size).toBe(4)
    expect(list.fileOf('disk:/1. PPV/PPV_Тест_3мин_05.04.25.MOV')).toEqual({
      localPath: '1. PPV/PPV_Тест_3мин_05.04.25.MOV',
      size: 1000,
      bytesPresent: true,
      attributes: PRESENT,
    })
    expect(list.readable('/1. PPV/PPV_Тест_3мин_05.04.25.MOV', 1000)?.size).toBe(1000)
  })

  it('maps `:` and a trailing space of the API path like the client did', () => {
    expect(list.readable('disk:/3. Customs/Ночь /13:03 хвост .mov', 700)?.localPath).toBe(
      '3. Customs/Ночь-/13-03 хвост .mov',
    )
  })

  it('keeps the name as on disk when the API spells it in NFC', () => {
    const file = list.readable('disk:/5. Sextings/Ёлка.jpg', 42)
    expect(file?.localPath).toBe(`5. Sextings/${'Ёлка'.normalize('NFD')}.jpg`)
  })

  it('sends placeholders, changed and unlisted files to the API', () => {
    expect(list.fileOf('disk:/1. PPV/архив.zip')?.bytesPresent).toBe(false)
    expect(list.readable('disk:/1. PPV/архив.zip', 5000)).toBeNull()
    expect(list.readable('disk:/1. PPV/PPV_Тест_3мин_05.04.25.MOV', 999)).toBeNull()
    expect(list.readable('disk:/1. PPV/нет такого.mov', 1)).toBeNull()
    expect(list.fileOf('disk:/1. PPV')).toBeNull()
  })

  it('trusts neither of two disk names with one NFC form', () => {
    const twins = CopyList.parse(
      [
        line('Ёлка.jpg', 1, PRESENT, true),
        line(`${'Ёлка'.normalize('NFD')}.jpg`, 1, PRESENT, true),
      ].join('\n'),
    )
    expect(twins.readable('disk:/Ёлка.jpg', 1)).toBeNull()
  })

  it('rejects a malformed list with the line number', () => {
    expect(() => parseCopyList(`${dir('a')}\n{"path":"a/b"}\n`)).toThrow('line 2')
    expect(() => parseCopyList('{oops')).toThrow('line 1: not JSON')
  })
})
