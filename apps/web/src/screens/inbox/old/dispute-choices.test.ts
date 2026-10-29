import type { Dispute } from '@contentops/contracts'
import { buildLoraLegacy } from '@contentops/contracts/fixtures/lora-legacy'
import { describe, expect, it } from 'vitest'
import { choiceByDigit, disputeChoices } from './dispute-choices'

const disputes = new Map(buildLoraLegacy().disputes.map((dispute) => [dispute.id, dispute]))

function dispute(id: string): Dispute {
  const found = disputes.get(id)
  if (!found) {
    throw new Error(`В фикстурах нет случая ${id}`)
  }
  return found
}

describe('решения спорного', () => {
  it('номер занят — «Так и сделать», варианты и «Неясно — оставить в разборе» последним', () => {
    const choices = disputeChoices(dispute('d-ppv-032'))
    expect(choices.primary).toEqual({ key: 'proposal', label: 'Так и сделать' })
    expect(choices.others.map((option) => option.key)).toEqual(['keep', 'new_number', 'typo'])
    expect(choices.unclear?.label).toBe('Неясно — оставить в разборе')
    expect(choiceByDigit(choices, 1)?.key).toBe('proposal')
    expect(choiceByDigit(choices, 3)?.key).toBe('new_number')
  })

  it('опечатка — «Так и сделать: PPV-067»', () => {
    expect(disputeChoices(dispute('d-ppv-066')).primary?.label).toBe('Так и сделать: PPV-067')
  })

  it('метка из имени — предложение и есть кнопка, «Привязать» не повторяется', () => {
    const choices = disputeChoices(dispute('d-label-1'))
    expect(choices.primary?.label).toBe('Привязать к Fansly 3, 04.08.26')
    expect(choices.others.map((option) => option.label)).toEqual(['Игнорировать'])
  })

  it('номер поста не путается с датой: «Fansly 3, 27.08 · пост 2»', () => {
    expect(disputeChoices(dispute('d-label-4')).primary?.label).toBe(
      'Привязать к Fansly 3, 27.08 · пост 2',
    )
  })

  it('(used1) в имени картинки — предложение по карточке меток, а не одно «Игнорировать»', () => {
    const choices = disputeChoices(dispute('d-picture-1'))
    expect(choices.primary?.label).toBe('Привязать к Fansly 1')
    expect(choiceByDigit(choices, 1)?.key).toBe('proposal')
    expect(choices.others.map((option) => option.label)).toEqual(['Игнорировать'])
  })

  it('без предложения «Привязать» остаётся и становится главной', () => {
    const choices = disputeChoices({ ...dispute('d-picture-1'), proposal: null })
    expect(choices.primary?.key).toBe('bind')
    expect(choices.others.map((option) => option.key)).toEqual(['ignore'])
  })

  it('без предложения главной становится первая кнопка случая', () => {
    const choices = disputeChoices(dispute('d-short-1'))
    expect(choices.primary?.label).toBe('Слить с соседней')
    expect(choices.others.map((option) => option.label)).toEqual(['Оставить'])
  })

  it('отложенный архив решений не имеет', () => {
    expect(disputeChoices(dispute('d-archive-ari'))).toEqual({
      primary: null,
      others: [],
      unclear: null,
    })
  })
})
