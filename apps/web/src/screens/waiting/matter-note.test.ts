import { describe, expect, it } from 'vitest'
import { matterNote } from './matter-note'

describe('the line under a matter of «Ждут вас»', () => {
  it('names Hub for the owner only; a content manager reads just since when', () => {
    expect(matterNote('2026-11-15T09:00:00+03:00', '2026-11-16', true)).toBe(
      'Hub · ждёт с 15 нояб.',
    )
    expect(matterNote('2026-11-15T09:00:00+03:00', '2026-11-16', false)).toBe('ждёт с 15 нояб.')
  })
})
