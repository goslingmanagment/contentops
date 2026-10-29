import { describe, expect, it } from 'vitest'
import { routerHrefOf } from './router-href'

const FILE = 'file:///Users/me/dist/index.html#/lora/library'
const SITE = 'https://contentops.local/lora/library'

describe('внутренняя ссылка для перехода без перезагрузки', () => {
  it('hash-адрес прототипа того же документа', () => {
    expect(routerHrefOf('#/lora/plan?view=week', FILE)).toBe('/lora/plan?view=week')
    expect(routerHrefOf('/Users/me/dist/index.html#/lora/plan', FILE)).toBe('/lora/plan')
  })

  it('путь от корня и полный адрес того же сайта на browser history', () => {
    expect(routerHrefOf('/lora/plan/2026-09-22?row=r1', SITE)).toBe('/lora/plan/2026-09-22?row=r1')
    expect(routerHrefOf('https://contentops.local/lora/inbox#x', SITE)).toBe('/lora/inbox#x')
  })

  it('чужой сайт, другой документ и относительный адрес — браузеру', () => {
    expect(routerHrefOf('https://t.me/c/123/456', SITE)).toBeNull()
    expect(routerHrefOf('//evil.example/lora', SITE)).toBeNull()
    expect(routerHrefOf('file:///Users/me/other.html#/lora/plan', FILE)).toBeNull()
    expect(routerHrefOf('plan', SITE)).toBeNull()
    expect(routerHrefOf('mailto:a@b.c', SITE)).toBeNull()
    expect(routerHrefOf('mailto:a@b.c', FILE)).toBeNull()
  })
})
