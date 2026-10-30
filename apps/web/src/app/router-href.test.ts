import { describe, expect, it } from 'vitest'
import { routerHrefOf } from './router-href'

const SITE = 'https://contentops.local/lora/library'

describe('внутренняя ссылка для перехода без перезагрузки', () => {
  it('путь от корня и полный адрес того же сайта', () => {
    expect(routerHrefOf('/lora/plan/2026-09-22?row=r1', SITE)).toBe('/lora/plan/2026-09-22?row=r1')
    expect(routerHrefOf('https://contentops.local/lora/inbox#x', SITE)).toBe('/lora/inbox#x')
  })

  it('чужой сайт и относительный адрес — браузеру', () => {
    expect(routerHrefOf('https://t.me/c/123/456', SITE)).toBeNull()
    expect(routerHrefOf('//evil.example/lora', SITE)).toBeNull()
    expect(routerHrefOf('plan', SITE)).toBeNull()
    expect(routerHrefOf('#/lora/plan', SITE)).toBeNull()
    expect(routerHrefOf('mailto:a@b.c', SITE)).toBeNull()
  })
})
