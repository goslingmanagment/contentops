import { describe, expect, it } from 'vitest'
import { checkList } from '../api/mock/views/check'
import { notUploadedPage } from '../api/mock/views/not-uploaded'
import { PROTOTYPE_NOW } from '../clock'
import type { CatalogEntry } from '../domain/catalog'
import { buildPageSummaries, type FactsContext } from './facts'
import { LORA_DETAILED_IDS } from './lora-catalog'
import { createWorld } from './world'
import type { ModelWorld, World } from './world-types'

function lora(world: World): ModelWorld {
  const model = world.models.get('lora')
  if (!model) throw new Error('нет Лоры')
  return model
}

function entries(model: ModelWorld): CatalogEntry[] {
  return [...model.items.values()]
    .filter((record) => record.lifecycle.state === 'active')
    .map((record) => record.entry)
}

function context(world: World): FactsContext {
  return { now: PROTOTYPE_NOW, world, model: lora(world) }
}

const world = createWorld()
const catalog = entries(lora(world))
const count = (predicate: (entry: CatalogEntry) => boolean) => catalog.filter(predicate).length

describe('каталог Лоры (DESIGN §9.3)', () => {
  it('1 391 объект по типам', () => {
    expect(catalog).toHaveLength(1391)
    expect({
      ppv: count((entry) => entry.type === 'ppv'),
      fyp: count((entry) => entry.type === 'fyp'),
      custom: count((entry) => entry.type === 'custom'),
      set: count((entry) => entry.type === 'set'),
      sexting: count((entry) => entry.type === 'sexting'),
      life: count((entry) => entry.type === 'life'),
      raw: count((entry) => entry.type === 'raw'),
      promo: count((entry) => entry.type === 'promo'),
    }).toEqual({
      ppv: 90,
      fyp: 796,
      custom: 197,
      set: 73,
      sexting: 12,
      life: 118,
      raw: 83,
      promo: 22,
    })
  })

  it('внутри типов: 52 бандла и 38 в личку, 150 SteadyContent, 5 фото-кастомов, 38 уже в PPV', () => {
    expect(count((entry) => entry.ppv_kind === 'bundle')).toBe(52)
    expect(count((entry) => entry.ppv_kind === 'dm')).toBe(38)
    expect(count((entry) => entry.steady_content)).toBe(150)
    expect(count((entry) => entry.photo_custom)).toBe(5)
    expect(count((entry) => entry.type === 'custom' && entry.ppv_made_as !== null)).toBe(38)
  })

  it('названия по-русски, 2–4 слова, ID по naming', () => {
    for (const entry of catalog) {
      expect(entry.title).toMatch(/[а-яё]/i)
      expect(entry.id).toMatch(/^(PPV|FYP|CUS|SET|SXT|LIFE|RAW|PRM)-\d{3,4}$/)
    }
  })

  it('подробные объекты на месте и точно по таблице', () => {
    const byId = new Map(catalog.map((entry) => [entry.id, entry]))
    for (const id of LORA_DETAILED_IDS) expect(byId.has(id), id).toBe(true)
    expect(byId.get('PPV-073')).toMatchObject({
      title: 'День рождения, торт, кружево',
      ppv_kind: 'bundle',
      duration_s: 804,
      photo_count: 21,
      version_count: 2,
    })
    expect(byId.get('PPV-075')).toMatchObject({ ppv_kind: 'dm', duration_s: 518, photo_count: 14 })
    expect(byId.get('CUS-181')).toMatchObject({
      duration_s: 492,
      fan_name: 'no',
      ppv_made_as: 'PPV-076',
    })
    expect(byId.get('CUS-197')).toMatchObject({
      title: 'Босс',
      duration_s: 937,
      delivered_on: '2026-09-18',
    })
    expect(byId.get('SET-074')).toMatchObject({
      photo_count: 46,
      selected_count: 21,
      processed_count: 8,
    })
    expect(byId.get('LIFE-191')).toMatchObject({ photo_count: 16, life_unassigned: 4 })
    expect(byId.get('SXT-012')?.aliases).toContain('S12')
  })

  it('где залит PPV-073: ✓ на Fansly 1 и 2, ◆ совпало 22 из 23 на Fansly 3, ✓ рассылка OF VIP, OF Free не видели', () => {
    const summaries = buildPageSummaries(context(world)).filter(
      (entry) => entry.item_id === 'PPV-073',
    )
    const on = (account: string) => summaries.find((entry) => entry.account === account)
    expect(on('lora-1')).toMatchObject({ sign: 'done', last_on: '2026-08-07' })
    expect(on('lora-2')).toMatchObject({ sign: 'done', last_on: '2026-08-08' })
    expect(on('lora-3')).toMatchObject({ sign: 'turn', detail: 'совпало 22 из 23' })
    expect(on('lora-vip-of')).toMatchObject({ sign: 'done', detail: 'вручную, Никита' })
    expect(on('lora-of')).toBeUndefined()
  })
})

describe('«Ещё не залито» по страницам (DESIGN §9.3)', () => {
  it('числа вкладок и групп совпадают с таблицей', () => {
    const facts = context(world)
    const groups = (account: string) =>
      Object.fromEntries(
        notUploadedPage(facts, account).groups.map((group) => [group.type, group.count]),
      )
    expect(groups('lora-1')).toEqual({ ppv: 6, set: 11, life: 9, fyp: 512 })
    expect(groups('lora-2')).toEqual({ ppv: 4, set: 14, life: 12, fyp: 488 })
    expect(groups('lora-3')).toEqual({ ppv: 5, set: 14, life: 12, fyp: 491 })
    expect(groups('lora-vip-of')).toEqual({ ppv: 21, set: 30, sexting: 7 })
    expect(groups('lora-of')).toEqual({ ppv: 38, set: 41, sexting: 12 })
    expect(
      notUploadedPage(facts, 'lora-2').groups.find((group) => group.type === 'ppv')?.item_ids,
    ).toContain('PPV-075')
  })

  it('строка покрытия: Fansly 1 — vault обойдён не полностью, OnlyFans — vault Hub не видит', () => {
    const facts = context(world)
    expect(notUploadedPage(facts, 'lora-1').coverage_note).toBe(
      'vault Fansly 1 Hub обошёл не полностью — часть может быть уже залита',
    )
    expect(notUploadedPage(facts, 'lora-2').coverage_note).toBeNull()
    expect(notUploadedPage(facts, 'lora-of').coverage_note).toBe(
      'vault OnlyFans Hub не видит — здесь всё, что не отмечено залитым',
    )
  })
})

describe('план и сверка (DESIGN §9.6, §9.7)', () => {
  it('неделя 21–27.09 по нормам и сегодняшний день', () => {
    const rows = [...lora(world).plan_rows.values()].filter((row) => !row.cancelled)
    const onDay = (date: string) => rows.filter((row) => row.date === date).length
    expect(onDay('2026-09-21')).toBe(6)
    expect(onDay('2026-09-23')).toBe(8)
    expect(onDay('2026-09-24')).toBe(17)
    expect(onDay('2026-09-25')).toBe(7)
    expect(onDay('2026-09-26') + onDay('2026-09-27')).toBe(0)
    expect(rows.filter((row) => row.release_id === 'rel-ppv-076')).toHaveLength(14)
  })

  it('Сверить · 8, «Hub не смог проверить 38» (31 + 7), решённые 12, не наше 3', () => {
    const list = checkList(context(world))
    expect(list.items).toHaveLength(8)
    expect(list.items.map((entry) => entry.kind).sort()).toEqual(
      [
        'candidate',
        'candidate',
        'candidate',
        'partial',
        'surface',
        'unplanned',
        'variants',
        'vault_stale',
      ].sort(),
    )
    expect(list.unverified).toEqual({
      total: 38,
      groups: [
        { reason: 'Hub видит не все посты этой страницы', count: 31 },
        { reason: 'Hub недоступен для OF Free с 13:52', count: 7 },
      ],
    })
    expect(list.resolved_count).toBe(12)
    expect(list.not_ours_count).toBe(3)
  })
})

describe('другие модели (DESIGN §9.2)', () => {
  it('Lily — 40 объектов, Ари — 12', () => {
    expect(world.models.get('lily')?.items.size).toBe(40)
    expect(world.models.get('ari')?.items.size).toBe(12)
  })
})

describe('детерминизм генератора', () => {
  it('два запуска дают один и тот же мир', () => {
    const again = createWorld()
    expect(entries(lora(again))).toEqual(catalog)
    expect(buildPageSummaries(context(again))).toEqual(buildPageSummaries(context(world)))
    expect([...lora(again).plan_rows.values()]).toEqual([...lora(world).plan_rows.values()])
  })
})
