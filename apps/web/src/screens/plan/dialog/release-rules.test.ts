import { beforeAll, describe, expect, it } from 'vitest'
import { type DialogTestWorld, loadDialogTestWorld } from './dialog-test-world'
import {
  cellKey,
  existingRelease,
  parseCell,
  releaseDay,
  releaseDefaults,
  releaseRows,
} from './release-rules'

let world: DialogTestWorld

beforeAll(async () => {
  world = await loadDialogTestWorld()
})

const TODAY = '2026-09-22'
const RELEASE_076 = {
  id: 'rel-076',
  item_id: 'PPV-076',
  date: '2026-09-24',
  row_ids: [],
  done: 0,
  accounts: 5,
}

describe('ячейки матрицы выпуска', () => {
  it('ключ «страница|место» читается обратно, чужое место — нет', () => {
    expect(parseCell(cellKey('lora-2', 'dm'))).toEqual({ account: 'lora-2', surface: 'dm' })
    expect(parseCell('lora-2|fyp')).toBeNull()
    expect(parseCell('lora-2')).toBeNull()
  })
})

describe('день выпуска по норме (раз в 2 недели по четвергам, DESIGN §9.6)', () => {
  it('без выпусков в плане — ближайший четверг', () => {
    expect(releaseDay(world.norms, TODAY)).toBe('2026-09-24')
  })

  it('выпуск PPV-076 уже стоит в чт 24 — новый встаёт через две недели, в чт 08.10', () => {
    expect(releaseDay(world.norms, TODAY, [RELEASE_076])).toBe('2026-10-08')
  })

  it('прошлый выпуск 10.09 — следующий по норме 24.09', () => {
    expect(releaseDay(world.norms, TODAY, [{ date: '2026-09-10' }])).toBe('2026-09-24')
  })
})

describe('матрица по виду PPV и норме', () => {
  it('бандл PPV-073: стена, сториз-тизер на всех пяти; рассылка — где стена 5 раз в неделю', () => {
    const form = releaseDefaults({
      entry: world.entry('PPV-073'),
      accounts: world.accounts,
      norms: world.norms,
      summaries: [],
      today: TODAY,
      date: undefined,
      releases: [RELEASE_076],
    })
    const surfaces = (surface: string) =>
      form.cells.filter((key) => key.endsWith(`|${surface}`)).map((key) => key.split('|')[0])
    expect(surfaces('wall')).toHaveLength(5)
    expect(surfaces('story')).toHaveLength(5)
    expect(surfaces('dm')).toEqual(['lora-1', 'lora-2', 'lora-3', 'lora-vip-of'])
    expect(surfaces('vault')).toEqual([])
    expect(form.slots.wall).toEqual({ date: '2026-10-08', time: '20:00' })
    expect(form.slots.story.time).toBe('20:30')
    expect(form.slots.dm.time).toBe('21:00')
  })

  it('в личку PPV-075: vault вместо стены', () => {
    const form = releaseDefaults({
      entry: world.entry('PPV-075'),
      accounts: world.accounts,
      norms: world.norms,
      summaries: [],
      today: TODAY,
      date: '2026-09-25',
    })
    expect(form.cells.some((key) => key.endsWith('|vault'))).toBe(true)
    expect(form.cells.some((key) => key.endsWith('|wall'))).toBe(false)
    expect(form.slots.vault).toEqual({ date: '2026-09-25', time: null })
  })

  it('PPV-076 уже стоит выпуском: матрица пустая, выпуск находится', () => {
    const form = releaseDefaults({
      entry: world.entry('PPV-076'),
      accounts: world.accounts,
      norms: world.norms,
      summaries: world.summaries('PPV-076'),
      today: TODAY,
      date: undefined,
    })
    expect(form.cells.filter((key) => !key.endsWith('|vault'))).toEqual([])
    expect(existingRelease(world.entry('PPV-076'), [RELEASE_076])).toBe(RELEASE_076)
    expect(existingRelease(world.entry('PPV-073'), [RELEASE_076])).toBeUndefined()
  })

  it('второй человек в кадре — OnlyFans пуст; строки идут по ячейкам со своим днём', () => {
    const entry = world.entry('PPV-085')
    const form = releaseDefaults({
      entry,
      accounts: world.accounts,
      norms: world.norms,
      summaries: [],
      today: TODAY,
      date: '2026-09-24',
    })
    expect(form.cells.some((key) => key.startsWith('lora-vip-of|'))).toBe(false)
    expect(form.cells.some((key) => key.startsWith('lora-of|'))).toBe(false)
    const rows = releaseRows(entry, form)
    expect(rows).toHaveLength(form.cells.length)
    expect(rows.find((row) => row.surface === 'story')?.time).toBe('20:30')
    expect(rows.every((row) => row.item_id === 'PPV-085' && row.date === '2026-09-24')).toBe(true)
  })
})
