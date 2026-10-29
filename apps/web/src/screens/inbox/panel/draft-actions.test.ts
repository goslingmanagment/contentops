import type { InboxGroup } from '@contentops/contracts'
import { buildCasesInbox } from '@contentops/contracts/fixtures/lora-inbox-cases'
import { describe, expect, it } from 'vitest'
import { draftActionsOf } from './draft-actions'

const groups = new Map(buildCasesInbox().map((record) => [record.group.id, record.group]))

function group(id: string): InboxGroup {
  const found = groups.get(id)
  if (!found) {
    throw new Error(`В фикстурах нет группы ${id}`)
  }
  return found
}

describe('кнопки панели решения', () => {
  it('готовое новое — «Принять», под ним ничего', () => {
    const model = draftActionsOf(group('g-sets-2109'))
    expect(model.primary).toMatchObject({ kind: 'accept', label: 'Принять', enabled: true })
    expect(model.secondary).toEqual(['extend', 'reject'])
    expect(model.note).toBeNull()
  })

  it('исправление кастома — «Принять как исправление» и вторая дорога «Принять отдельно»', () => {
    const model = draftActionsOf(group('g-341'))
    expect(model.primary.label).toBe('Принять как исправление')
    expect(model.primary.command).toEqual({ as: 'default' })
    expect(model.note).toEqual({ kind: 'switch', label: 'Принять отдельно', separate: true })
  })

  it('вторая дорога принимает отдельно и ведёт обратно к цели', () => {
    const fix = draftActionsOf(group('g-341'), true)
    expect(fix.primary).toMatchObject({ label: 'Принять отдельно', command: { as: 'separate' } })
    expect(fix.note).toEqual({ kind: 'switch', label: 'Как исправление CUS-195', separate: false })
    const extend = draftActionsOf(group('g-set074-plus3'), true)
    expect(extend.primary.label).toBe('Принять отдельным объектом')
    expect(extend.note).toMatchObject({ label: 'Дополнить SET-074', separate: false })
  })

  it('дополнение принятой папки — «Принять» и «Отдельным объектом»', () => {
    const model = draftActionsOf(group('g-set074-plus3'))
    expect(model.note).toMatchObject({ kind: 'switch', label: 'Отдельным объектом' })
  })

  it('◆ «Какой заказ?» — «Принять» недоступна, причина одной строкой', () => {
    const model = draftActionsOf(group('g-2254'))
    expect(model.primary.enabled).toBe(false)
    expect(model.note).toEqual({ kind: 'reason', text: 'Сначала выберите заказ' })
  })

  it('номер ещё не выдаётся — «Принять» недоступна, «Дополнить…» остаётся', () => {
    const model = draftActionsOf(group('g-sxt-robe'))
    expect(model.primary.enabled).toBe(false)
    expect(model.note).toEqual({
      kind: 'reason',
      text: 'Номер выдадим после разбора старого Я.Диска',
    })
    expect(model.secondary).toContain('extend')
  })

  it('▲ чинится главной кнопкой: «Повторить», «Ждать», «Загрузить заново»', () => {
    expect(draftActionsOf(group('g-1717')).primary).toMatchObject({
      kind: 'retry',
      label: 'Повторить',
    })
    expect(draftActionsOf(group('g-vanished')).primary).toMatchObject({
      kind: 'wait',
      label: 'Ждать',
    })
    expect(draftActionsOf(group('g-upload-teaser')).primary).toMatchObject({
      kind: 'reupload',
      label: 'Загрузить заново',
    })
    expect(draftActionsOf(group('g-1717')).secondary).toEqual(['reject'])
  })

  it('◆ «Подставить монтаж в строку?» — «Подставить» и «Оставить в каталоге»', () => {
    const model = draftActionsOf(group('g-montage-f1'))
    expect(model.primary).toMatchObject({ kind: 'substitute', label: 'Подставить', enabled: true })
    expect(model.secondary).toEqual(['keep_in_catalog'])
  })

  it('готовится — «Принять» недоступна с долей словами', () => {
    const model = draftActionsOf(group('g-ppv-short'))
    expect(model.primary.enabled).toBe(false)
    expect(model.note).toEqual({ kind: 'reason', text: 'Мастер ещё собирается · 62 %' })
  })
})
