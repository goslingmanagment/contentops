import type { SlotGap } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { spreadSurface } from './drawer-candidates'

const vaultGap: SlotGap = {
  date: '2026-09-29',
  account: 'lora-1',
  kind: 'life_vault',
  surface: 'vault',
  time: null,
  text: 'Здесь нужен лайф в vault',
}

describe('место раскладки из ящика недели (DESIGN §4.12)', () => {
  it('лайф — в vault, если норма ждёт на неделе лайф в vault, иначе на стену', () => {
    expect(spreadSurface('life', ['lora-1'], [vaultGap])).toBe('vault')
    expect(spreadSurface('life', ['lora-2'], [vaultGap])).toBe('wall')
    expect(spreadSurface('life', ['lora-1'], [])).toBe('wall')
  })

  it('фуп — в ленту, секстинг — в vault, сет — на стену', () => {
    expect(spreadSurface('fyp', ['lora-1'], [vaultGap])).toBe('fyp')
    expect(spreadSurface('sexting', ['lora-1'], [])).toBe('vault')
    expect(spreadSurface('set', ['lora-1'], [vaultGap])).toBe('wall')
  })
})
