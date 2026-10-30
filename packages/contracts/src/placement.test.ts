import { describe, expect, it } from 'vitest'
import { mskInstant } from './clock'
import type { Evidence, PersonName, PlacementFacts, PlanFacts } from './domain/placement'
import { evaluatePlacement } from './placement'
import { describeEvidence } from './placement/texts'

/** One test per row of DESIGN §5.2: facts in, level, sign, word and «почему» out. */

const DIANA: PersonName = { name: 'Диана', gender: 'f' }
const at = (time: string, date = '2026-09-22') => mskInstant(date, time)
const NOW = at('14:20')

function plan(patch: Partial<PlanFacts> = {}): PlanFacts {
  return {
    slot_date: '2026-09-22',
    slot_time: '20:00',
    created_by: DIANA,
    created_at: at('10:15', '2026-09-19'),
    mark: null,
    cancelled: null,
    copy: { state: 'ready', size_bytes: 18_000_000 },
    second_person_blocked: false,
    has_newer_version: false,
    requires_new_upload: false,
    awaiting_montage_from: null,
    ...patch,
  }
}

function marked(time: string, kind: 'posted' | 'scheduled' = 'posted', date = '2026-09-22') {
  return {
    kind,
    at: at(time, date),
    by: DIANA,
    stated_occurred_at: null,
    for_current_manifest: true,
  }
}

function facts(patch: Partial<PlacementFacts> = {}): PlacementFacts {
  return {
    now: NOW,
    account: { code: 'lora-2', label: 'Fansly 2', platform: 'fansly' },
    surface: 'wall',
    hub: { state: 'complete', since: null, visible_from: '2025-02-01' },
    plan: null,
    evidence: [],
    thresholds: { wait_hub_hours: 8, not_published_hours: null },
    ...patch,
  }
}

/** Evidence without the bookkeeping fields, distributed over the union. */
type EvidenceInput = Evidence extends infer Each
  ? Each extends Evidence
    ? Omit<Each, 'id' | 'recorded_at'>
    : never
  : never

let counter = 0
function evidence(input: EvidenceInput, recordedAt = at('09:00')): Evidence {
  counter += 1
  return { ...input, id: `e-${counter}`, recorded_at: recordedAt } as Evidence
}

const exactByName = evidence({
  kind: 'hub_exact',
  post_at: at('03:06'),
  match: 'file_name',
  file_name: 'FYP-0801_zerkalo-chernoe-bodi_master_u1__lora-2_2026-09-22_0300.mp4',
  duration: { ours_s: 9, theirs_s: 9 },
})

describe('уровень размещения по строкам таблицы DESIGN §5.2', () => {
  it('Запланировано → «в плане»', () => {
    const verdict = evaluatePlacement(facts({ plan: plan() }))
    expect(verdict).toMatchObject({ level: 'planned', sign: null, word: 'в плане' })
    expect(verdict.reason).toBe('В плане на 20:00 · поставила Диана 19.09 · копия готова')
  })

  it('Пропущена → ▲ «пропущено»', () => {
    const verdict = evaluatePlacement(facts({ plan: plan({ slot_time: '13:00' }) }))
    expect(verdict).toMatchObject({ level: 'missed', sign: 'trouble', word: 'пропущено' })
    expect(verdict.reason).toBe('Время прошло 1 ч 20 мин назад, отметки нет')
  })

  it('Отмечено КМ, сториз на Fansly → ✓ «отмечено · учёт вручную»', () => {
    const verdict = evaluatePlacement(
      facts({ surface: 'story', plan: plan({ slot_time: '13:00', mark: marked('13:05') }) }),
    )
    expect(verdict).toMatchObject({
      level: 'marked_manual',
      sign: 'done',
      word: 'отмечено',
      detail: 'учёт вручную',
    })
    expect(verdict.reason).toBe('Отметила Диана 13:05')
  })

  it('КМ отметил, ждём Hub → «отмечено»', () => {
    const verdict = evaluatePlacement(
      facts({ surface: 'vault', plan: plan({ slot_time: '11:40', mark: marked('11:42') }) }),
    )
    expect(verdict).toMatchObject({ level: 'marked', sign: null, word: 'отмечено' })
    expect(verdict.reason).toBe('Отметила Диана 11:42 · Hub ещё не видел')
  })

  it('Поставлено в нативный планировщик → «в планировщике»', () => {
    const verdict = evaluatePlacement(facts({ plan: plan({ mark: marked('11:30', 'scheduled') }) }))
    expect(verdict).toMatchObject({ level: 'scheduled', sign: null, word: 'в планировщике' })
    expect(verdict.reason).toBe('Поставлено на 20:00')
  })

  it('Подтверждено точно, Hub → ✓ «подтверждено · Hub, по имени файла»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'fyp',
        plan: plan({ slot_time: '03:00', mark: marked('22:10', 'scheduled', '2026-09-21') }),
        evidence: [exactByName],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'confirmed_exact',
      sign: 'done',
      word: 'подтверждено',
      detail: 'Hub, по имени файла',
    })
    expect(verdict.reason).toBe(
      'Пост 03:06 · имя `FYP-0801_zerkalo-chernoe-bodi_master_u1__lora-2_2026-09-22_0300.mp4` · 0:09 = 0:09',
    )
  })

  it('Подтверждено Hub без отметки КМ → ✓, и ✓ важнее ▲ «пропущено»', () => {
    const verdict = evaluatePlacement(
      facts({ surface: 'fyp', plan: plan({ slot_time: '03:00' }), evidence: [exactByName] }),
    )
    expect(verdict).toMatchObject({
      level: 'confirmed_hub_unmarked',
      sign: 'done',
      detail: 'Hub, без отметки',
    })
    expect(verdict.reason).toBe('Пост 03:06 по имени файла; отметки КМ нет')
  })

  it('Подтверждено вручную: осмотренная пара и отчёт о выполнении', () => {
    const pair = evaluatePlacement(
      facts({ evidence: [evidence({ kind: 'manual_confirm', by: DIANA, basis: 'pair' })] }),
    )
    expect(pair).toMatchObject({
      level: 'confirmed_manual',
      sign: 'done',
      detail: 'вручную, Диана',
      reason: 'Осмотренная пара',
    })
    const report = evaluatePlacement(
      facts({ evidence: [evidence({ kind: 'manual_confirm', by: DIANA, basis: 'report' })] }),
    )
    expect(report.reason).toBe('Отчёт о выполнении')
  })

  it('Подтверждено ранее вручную (повтор файла на OnlyFans)', () => {
    const verdict = evaluatePlacement(
      facts({
        account: { code: 'lora-vip-of', label: 'OF VIP', platform: 'onlyfans' },
        evidence: [evidence({ kind: 'manual_earlier', confirmed_on: '2026-08-12' })],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'confirmed_earlier',
      sign: 'done',
      detail: 'ранее вручную',
    })
    expect(verdict.reason).toBe('Тот же файл OnlyFans, подтверждён 12.08')
  })

  it('Нужна новая заливка — выполнена → ✓ «новый файл 22.09»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'vault',
        plan: plan({ slot_time: null, requires_new_upload: true, mark: marked('10:00') }),
        evidence: [exactByName, evidence({ kind: 'vault_reupload', file_on: '2026-09-22' })],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'confirmed_reupload',
      sign: 'done',
      detail: 'новый файл 22.09',
    })
    expect(verdict.reason).toBe('Файл создан на платформе 22.09, позже строки')
  })

  it('Кандидат → ◆ «сверить · Hub нашёл похожее»', () => {
    const verdict = evaluatePlacement(
      facts({
        evidence: [
          evidence({
            kind: 'hub_candidate',
            post_at: at('03:06'),
            offset_min: 6,
            summary: '1 видео 0:09 = 0:09 · имя не наше',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'candidate',
      sign: 'turn',
      word: 'сверить',
      detail: 'Hub нашёл похожее',
    })
    expect(verdict.reason).toBe('Пост 03:06, +6 мин · 1 видео 0:09 = 0:09 · имя не наше')
  })

  it('Несколько кандидатов → ◆ «2 варианта»', () => {
    const verdict = evaluatePlacement(
      facts({
        evidence: [
          evidence({
            kind: 'hub_candidate',
            post_at: at('20:07'),
            offset_min: 7,
            summary: '1 видео',
          }),
          evidence({
            kind: 'hub_candidate',
            post_at: at('19:58'),
            offset_min: -2,
            summary: '1 видео',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'candidates_multiple',
      sign: 'turn',
      detail: '2 варианта',
      reason: 'Посты 19:58 и 20:07',
    })
  })

  it('Совпало k из n → ◆ «совпало 22 из 23»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'vault',
        evidence: [
          evidence({ kind: 'hub_partial', matched: 22, total: 23, missing: 'нет фото 17' }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'partial_match',
      sign: 'turn',
      detail: 'совпало 22 из 23',
      reason: 'Нет фото 17',
    })
  })

  it('Расхождение → ◆ «длительность 0:09 и 0:11»', () => {
    const verdict = evaluatePlacement(
      facts({
        evidence: [
          evidence({
            kind: 'hub_mismatch',
            post_at: at('03:05'),
            field: 'duration',
            ours: '0:09',
            theirs: '0:11',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'mismatch',
      sign: 'turn',
      detail: 'длительность 0:09 и 0:11',
    })
  })

  it('Конфликт размещения → ◆ «отметка и Hub расходятся»', () => {
    const verdict = evaluatePlacement(
      facts({
        plan: plan({ mark: marked('20:00') }),
        evidence: [
          evidence({ kind: 'hub_conflict', post_at: at('20:01'), other: 'пост другого файла' }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'conflict',
      sign: 'turn',
      detail: 'отметка и Hub расходятся',
    })
    expect(verdict.reason).toBe('Отмечено 20:00, а Hub видит в это время пост другого файла')
  })

  it('Поверхность не подтверждена → ◆ «стена или фуп?»', () => {
    const verdict = evaluatePlacement(
      facts({ evidence: [evidence({ kind: 'hub_surface_unknown', post_at: at('03:06') })] }),
    )
    expect(verdict).toMatchObject({
      level: 'surface_unknown',
      sign: 'turn',
      detail: 'стена или фуп?',
      reason: 'Файл совпал точно, пост 03:06',
    })
  })

  it('Публикация без плана → ◆ «пост без плана»', () => {
    const verdict = evaluatePlacement(
      facts({
        evidence: [
          evidence({
            kind: 'hub_unplanned',
            post_at: at('11:02'),
            surface_seen: 'wall',
            summary: '1 видео 0:07',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'unplanned_post',
      sign: 'turn',
      detail: 'пост без плана',
    })
    expect(verdict.reason).toBe('Hub видел на стене 11:02 · 1 видео 0:07')
  })

  it('Заливка не найдена → ◆ «в альбоме нет файла»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'vault',
        evidence: [
          evidence({
            kind: 'vault_missing',
            album: 'SXT-005 Розовые стринги',
            walked_on: '2026-09-21',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'vault_missing',
      sign: 'turn',
      detail: 'в альбоме нет файла',
    })
    expect(verdict.reason).toBe('Альбом «SXT-005 Розовые стринги» обойдён 21.09, файла нет')
  })

  it('В альбоме только старый файл → ◆ «старый файл в альбоме»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'vault',
        plan: plan({
          slot_date: '2026-09-20',
          slot_time: null,
          requires_new_upload: true,
          mark: marked('14:10', 'posted', '2026-09-20'),
        }),
        evidence: [
          evidence({
            kind: 'vault_stale',
            album: 'SXT-005 Розовые стринги',
            file_on: '2026-08-12',
            row_on: '2026-09-20',
          }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'vault_stale',
      sign: 'turn',
      detail: 'старый файл в альбоме',
    })
    expect(verdict.reason).toBe('В альбоме файл от 12.08, строка от 20.09')
  })

  it('Не удалось проверить → «не проверено» с причиной', () => {
    const late = plan({ slot_date: '2026-09-21', mark: marked('22:10', 'scheduled', '2026-09-20') })
    const partial = evaluatePlacement(
      facts({ hub: { state: 'partial', since: null, visible_from: null }, plan: late }),
    )
    expect(partial).toMatchObject({
      level: 'cannot_verify',
      sign: null,
      word: 'не проверено',
      reason: 'Hub видит не все посты этой страницы',
    })
    const off = evaluatePlacement(
      facts({
        hub: { state: 'off', since: null, visible_from: null },
        plan: { ...late, mark: marked('20:02', 'posted', '2026-09-21') },
      }),
    )
    expect(off.reason).toBe('Hub выключен для Fansly 2')
    const down = evaluatePlacement(
      facts({ hub: { state: 'down', since: at('13:52'), visible_from: null }, plan: late }),
    )
    expect(down.reason).toBe('Hub недоступен для Fansly 2 с 13:52')
  })

  it('Неизвестно → «не видели»', () => {
    const verdict = evaluatePlacement(
      facts({
        account: { code: 'lora-1', label: 'Fansly 1', platform: 'fansly' },
        hub: { state: 'complete', since: null, visible_from: '2025-01-19' },
      }),
    )
    expect(verdict).toMatchObject({ level: 'unknown', sign: null, word: 'не видели' })
    expect(verdict.reason).toBe('Плана, отметок и постов Hub нет. Hub видит Fansly 1 с 19.01.2025')
  })

  it('Не найден при обходе от даты → «не проверено»', () => {
    const verdict = evaluatePlacement(
      facts({
        surface: 'vault',
        evidence: [evidence({ kind: 'walk_not_found', walked_from: '2026-09-01' })],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'not_found_in_walk',
      word: 'не проверено',
      reason: 'Не найден при обходе от 01.09',
    })
  })

  it('Не вышло (после E7) → ▲ «не вышло»', () => {
    const verdict = evaluatePlacement(
      facts({
        plan: plan({ slot_date: '2026-09-20', mark: marked('20:02', 'posted', '2026-09-20') }),
        thresholds: { wait_hub_hours: 8, not_published_hours: 24 },
      }),
    )
    expect(verdict).toMatchObject({ level: 'not_published', sign: 'trouble', word: 'не вышло' })
    expect(verdict.reason).toBe('Прошло 24 ч, Hub видит все посты Fansly 2, похожих нет')
  })

  it('Старое имя «выходило» → серая подпись, не подтверждение', () => {
    const verdict = evaluatePlacement(
      facts({ evidence: [evidence({ kind: 'legacy_claim', label: 'used2', on: '2026-07-31' })] }),
    )
    expect(verdict.level).toBe('unknown')
    expect(verdict.notes).toEqual(['в старом имени: used2 · 31.07'])
  })

  it('Вне каталога → «не наше»', () => {
    const verdict = evaluatePlacement(
      facts({
        evidence: [
          evidence({
            kind: 'hub_unplanned',
            post_at: at('11:02'),
            surface_seen: 'wall',
            summary: 'ссылка',
          }),
          evidence({ kind: 'outside_catalog', by: DIANA }),
        ],
      }),
    )
    expect(verdict).toMatchObject({
      level: 'outside_catalog',
      word: 'не наше',
      reason: 'Отметила Диана: не наш материал',
    })
  })

  it('Отказ: пара «Не то» уходит в «Как проверяли», вопроса больше нет', () => {
    const candidate = evidence({
      kind: 'hub_candidate',
      post_at: at('03:06'),
      offset_min: 6,
      summary: '1 видео',
    })
    const reject = evidence(
      { kind: 'manual_reject', by: DIANA, rejects: candidate.id },
      at('10:00', '2026-09-21'),
    )
    const verdict = evaluatePlacement(
      facts({ plan: plan({ mark: marked('11:30', 'scheduled') }), evidence: [candidate, reject] }),
    )
    expect(verdict.level).toBe('scheduled')
    expect(describeEvidence(reject, '2026-09-22')).toBe('Не то · Диана 21.09')
  })

  it('Отменена → строка скрыта, «почему» с причиной', () => {
    const verdict = evaluatePlacement(
      facts({ plan: plan({ cancelled: { at: at('12:30'), by: DIANA, reason: 'late' } }) }),
    )
    expect(verdict).toMatchObject({
      level: 'cancelled',
      word: 'отменена',
      reason: 'Отменена · не успели · Диана',
    })
  })

  it('Есть новая версия → подпись у строки', () => {
    const verdict = evaluatePlacement(facts({ plan: plan({ has_newer_version: true }) }))
    expect(verdict.notes).toContain('Есть новая версия — заменить состав?')
  })

  it('Отметка относится к прежнему составу → серая подпись', () => {
    const verdict = evaluatePlacement(
      facts({
        plan: plan({ mark: { ...marked('11:30', 'scheduled'), for_current_manifest: false } }),
      }),
    )
    expect(verdict.notes).toContain('Состав заменили после отметки')
  })

  it('Второй человек в кадре на OnlyFans → ▲ «нельзя на OnlyFans»', () => {
    const verdict = evaluatePlacement(
      facts({
        account: { code: 'lora-of', label: 'OF Free', platform: 'onlyfans' },
        plan: plan({ second_person_blocked: true }),
      }),
    )
    expect(verdict).toMatchObject({
      level: 'blocked_second_person',
      sign: 'trouble',
      word: 'нельзя на OnlyFans',
    })
  })
})
