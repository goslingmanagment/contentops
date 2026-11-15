import { describe, expect, it } from 'vitest'
import { postRefOf } from './post-ref'

describe('«Вышел»: the post on the platform', () => {
  it('takes the number as Hub does', () => {
    expect(postRefOf(' 851203394123456789 ')).toBe('851203394123456789')
  })

  it('takes it from a pasted Fansly or OnlyFans link', () => {
    expect(postRefOf('https://fansly.com/post/851203394123456789')).toBe('851203394123456789')
    expect(postRefOf('fansly.com/post/851203394123456789?ref=x')).toBe('851203394123456789')
    expect(postRefOf('https://onlyfans.com/1234567890/lora')).toBe('1234567890')
  })

  it('refuses anything else', () => {
    expect(postRefOf('')).toBeNull()
    expect(postRefOf('номер 12')).toBeNull()
    expect(postRefOf('https://fansly.com/lora/posts')).toBeNull()
    expect(postRefOf('https://example.com/post/12')).toBeNull()
  })
})
