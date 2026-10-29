import type { InboxGroup } from '@contentops/contracts'
import { buildLoraInbox } from '@contentops/contracts/fixtures/lora-inbox'
import { describe, expect, it } from 'vitest'
import { batchModelOf, canMergeGroups, isAcceptable } from './batch'

const groups = new Map(buildLoraInbox().map((record) => [record.group.id, record.group]))

function pick(...ids: string[]): InboxGroup[] {
  return ids.map((id) => {
    const group = groups.get(id)
    if (!group) {
      throw new Error(`В фикстурах нет группы ${id}`)
    }
    return group
  })
}

describe('пакет «Приехало»', () => {
  it('«похоже на исправление» пакет не принимает', () => {
    expect(pick('g-341').map(isAcceptable)).toEqual([false])
    expect(batchModelOf(pick('g-sets-2109', 'g-341', 'g-life-16')).acceptable.length).toBe(2)
  })

  it('сливаются только готовые группы одного вида', () => {
    expect(canMergeGroups(pick('g-sets-2109', 'g-set074-plus3'))).toBe(true)
    expect(canMergeGroups(pick('g-sets-2109', 'g-life-16'))).toBe(false)
    expect(canMergeGroups(pick('g-1717', 'g-2254'))).toBe(false)
    expect(canMergeGroups(pick('g-archive', 'g-sets-2109'))).toBe(false)
    expect(canMergeGroups(pick('g-sets-2109'))).toBe(false)
  })
})
