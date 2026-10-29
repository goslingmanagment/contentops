import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import { createApiClient } from '../client'
import { createMockFetch } from './mock-fetch'

const lora = { model: 'lora' }

function setup() {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW), operation_ms: 0 }),
  )
}

describe('План › День: ряд дат (DESIGN §4.11)', () => {
  it('точки по тем же строкам, что в списке: у Дианы с «Мои» на вт 22 ◆, а не ▲ Никиты', async () => {
    const api = setup()
    const dotOf = (day: { week_dots: { date: string; sign: string | null }[] }) =>
      day.week_dots.find((dot) => dot.date === '2026-09-22')?.sign
    const all = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const mine = await api.plan.day({ params: lora, query: { date: '2026-09-22', mine: true } })
    expect(dotOf(all)).toBe('trouble')
    expect(dotOf(mine)).toBe('turn')
    expect(mine.rows.some((row) => row.verdict.sign === 'trouble')).toBe(false)
  })
})

describe('Скачать для заливки из строки плана (DESIGN §2.5, §4.11)', () => {
  it('у лайфа — кадры с назначением по порядку архивом, в имени день и время строки', async () => {
    const api = setup()
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const life = day.rows.find(
      (row) => row.manifest?.item_id === 'LIFE-191' && row.account === 'lora-2',
    )
    expect(life?.manifest?.files).toEqual([
      {
        key: 'platform',
        label: 'Фото 12 шт. и 2 видео, по порядку',
        download_name: 'LIFE-191_zavtrak-okna_pic__lora-2_2026-09-22_1140.zip',
      },
    ])
    if (!life?.manifest) return
    const answer = await api.objects.download({
      params: { ...lora, id: 'LIFE-191' },
      body: { kind: 'platform', strip_metadata: true, account: 'lora-2', plan_row: life.id },
    })
    expect(answer.kind === 'ready' && answer.file_name).toBe(life.manifest.files[0]?.download_name)
  })

  it('у PPV на стене — мастер, тизер и фото; у фупа — версия строки и время 03:00', async () => {
    const api = setup()
    const thursday = await api.plan.day({ params: lora, query: { date: '2026-09-24' } })
    const wall = thursday.rows.find(
      (row) => row.manifest?.item_id === 'PPV-076' && row.surface === 'wall',
    )
    expect(wall?.manifest?.files.map((file) => file.key)).toEqual(['platform', 'teaser'])
    const preview = await api.plan.createRows({
      params: lora,
      query: { dry_run: true },
      body: {
        rows: [
          {
            item_id: 'PPV-073',
            account: 'lora-of',
            surface: 'wall',
            date: '2026-09-26',
            time: '19:00',
            fyp_version: null,
            assignee: null,
            note: null,
            requires_new_upload: false,
            awaiting_montage: null,
            marked: null,
          },
        ],
      },
    })
    expect(preview.rows[0]?.manifest?.files.map((file) => file.label)).toEqual([
      'Мастер 13:24',
      'Тизер',
      'Фото 21 шт., по порядку',
    ])
    const today = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const fyp = (account: string) =>
      today.rows.find((row) => row.manifest?.item_id === 'FYP-0801' && row.account === account)
        ?.manifest?.files[0]?.download_name
    expect(fyp('lora-2')).toBe(
      'FYP-0801_zerkalo-chernoe-bodi_master_u1__lora-2_2026-09-22_0300.mp4',
    )
    expect(fyp('lora-3')).toBe(
      'FYP-0801_zerkalo-chernoe-bodi_master_u2__lora-3_2026-09-22_0300.mp4',
    )
  })
})

describe('объём копий (DESIGN §6.4)', () => {
  it('копия весит по длине и типу: рассылка PPV-076 8:12 — 689 МБ, тизер — 42 МБ, фуп — мало', async () => {
    const api = setup()
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-24' } })
    const fansly1 = day.rows.filter((row) => row.account === 'lora-1')
    const sizeOf = (surface: string) => {
      const copy = fansly1.find((row) => row.surface === surface)?.copy
      return copy?.state === 'ready' ? copy.size_bytes : null
    }
    expect(sizeOf('dm')).toBe(688_800_000)
    expect(sizeOf('story')).toBe(42_000_000)
    expect(sizeOf('fyp')).toBeLessThan(30_000_000)
    // Стена собирается; когда соберётся, страница выпуска — около 1,4 ГБ (§6.4).
    expect((sizeOf('dm') ?? 0) * 2 + (sizeOf('story') ?? 0)).toBeGreaterThan(1_350_000_000)
  })

  it('у лайфа копия — фото: 16 × 2,4 МБ', async () => {
    const api = setup()
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const life = day.rows.find((row) => row.manifest?.item_id === 'LIFE-191')
    expect(life?.copy).toEqual({ state: 'ready', size_bytes: 38_400_000 })
  })
})
