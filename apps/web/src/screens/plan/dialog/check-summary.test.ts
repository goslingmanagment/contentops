import type { PlanWarning, RowCheckResult } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { batchSummary, pickCheck, type RowNote } from './check-summary'

function result(
  text: string,
  warnings: PlanWarning[],
  blocked = false,
  pageText = text,
): RowCheckResult {
  const first = warnings[0]
  return {
    tone: first && first.kind !== 'threshold_unset' ? 'attention' : 'muted',
    text,
    page_text: pageText,
    blocked,
    warnings,
  }
}

const page = (label: string, check: RowCheckResult) => ({ label, result: check })

const SAME_TIME: PlanWarning = { kind: 'same_time', other_item: 'PPV-072', text: '…' }
const ALREADY: PlanWarning = { kind: 'already_planned', date: '2026-09-22', text: '…' }
const TOO_EARLY: PlanWarning = { kind: 'too_early', account: 'lora-2', days: 0, text: '…' }
const UNSET: PlanWarning = { kind: 'threshold_unset', text: 'порог «слишком рано» не задан' }

describe('одна строка проверки из ответов по страницам (DESIGN §4.13)', () => {
  it('одна страница — её фраза целиком', () => {
    const summary = pickCheck([
      page('Fansly 1', result('Повторов нет · на Fansly 1 ещё не было', [], false, 'не было')),
    ])
    expect(summary).toMatchObject({ tone: 'muted', text: 'Повторов нет · на Fansly 1 ещё не было' })
  })

  it('несколько страниц — каждая своим ответом, важное первым', () => {
    const summary = pickCheck([
      page('Fansly 1', result('Повторов нет · на Fansly 1 ещё не было', [], false, 'не было')),
      page(
        'Fansly 2',
        result(
          'Слишком рано: на Fansly 2 было 22.09 — сегодня',
          [TOO_EARLY],
          false,
          'слишком рано, было 22.09 — сегодня',
        ),
      ),
    ])
    expect(summary).toMatchObject({
      tone: 'attention',
      text: 'Fansly 2: слишком рано, было 22.09 — сегодня · Fansly 1: не было',
    })
  })

  it('«уже в плане» на одной странице важнее «двух постов» на другой', () => {
    const summary = pickCheck([
      page('OF Free', result('…', [], false, 'не было')),
      page(
        'OF VIP',
        result('…', [SAME_TIME], false, 'в 20:00 уже стоит PPV-072 — два поста в одно время'),
      ),
      page(
        'Fansly 1',
        result('…', [ALREADY], false, 'уже в плане на вт 22.09, 20:00 (в планировщике)'),
      ),
    ])
    expect(summary?.text).toBe(
      'Fansly 1: уже в плане на вт 22.09, 20:00 (в планировщике) · OF VIP: в 20:00 уже стоит PPV-072 — два поста в одно время · OF Free: не было',
    )
  })

  it('сказать нечего — «Повторов нет» и ответ каждой страницы', () => {
    const summary = pickCheck([
      page('Fansly 1', result('…', [], false, 'не было')),
      page('Fansly 2', result('…', [], false, 'было 13.09 — 9 дней назад')),
    ])
    expect(summary).toMatchObject({
      tone: 'muted',
      text: 'Повторов нет · Fansly 1: не было · Fansly 2: было 13.09 — 9 дней назад',
    })
  })

  it('отказ держит строку сильнее любого янтаря', () => {
    const summary = pickCheck([
      page('Fansly 1', result('Уже в плане: Fansly 1', [ALREADY])),
      page('OF VIP', result('нельзя: второй человек в кадре', [], true)),
    ])
    expect(summary?.tone).toBe('blocked')
    expect(summary?.text.startsWith('OF VIP: нельзя')).toBe(true)
  })

  it('порог не задан — серым, и «задать» видно, даже если выше янтарь', () => {
    const summary = pickCheck([
      page('Fansly 1', result('Порог «слишком рано» не задан', [UNSET])),
      page('OF VIP', result('В 20:00 на OF VIP уже стоит PPV-072', [SAME_TIME, UNSET])),
    ])
    expect(summary).toMatchObject({ tone: 'attention', thresholdUnset: true })
  })

  it('ответов ещё нет — строки нет', () => {
    expect(pickCheck([])).toBeNull()
  })
})

describe('строка проверки пакета', () => {
  const note = (text: string, rank: number): RowNote => ({ tone: 'attention', text, rank })

  it('самая важная пометка полной фразой и сколько ещё таких строк', () => {
    const summary = batchSummary([
      null,
      note('в 21:00 на Fansly 1 уже стоит SET-073 — два поста в одно время', 2),
      note('в 21:00 на Fansly 2 уже стоит SET-073 — два поста в одно время', 2),
      note('в 21:00 на OF VIP уже стоит PPV-072 — два поста в одно время', 2),
    ])
    expect(summary.text).toBe(
      'В 21:00 на Fansly 1 уже стоит SET-073 — два поста в одно время · ещё 2 такие строки',
    )
  })

  it('без пометок — «Повторов нет»', () => {
    expect(batchSummary([null, null])).toMatchObject({ tone: 'muted', text: 'Повторов нет' })
  })
})
