import { describe, expect, it } from 'vitest'
import { modelSwitchHref } from './model-switch-path'

describe('смена модели', () => {
  it('раздел и вид переносятся на ту же страницу другой модели', () => {
    expect(modelSwitchHref('/lora/plan/2026-09-22', {}, 'lily')).toBe('/lily/plan/2026-09-22')
    expect(modelSwitchHref('/lora/plan/w/2026-W39', {}, 'lily')).toBe('/lily/plan/w/2026-W39')
    expect(modelSwitchHref('/lora/inbox/done', {}, 'ari')).toBe('/ari/inbox/done')
    expect(modelSwitchHref('/lora/library/customs', { view: 'orders' }, 'ari')).toBe(
      '/ari/library/customs?view=orders',
    )
  })

  it('фильтры и сортировка ссылаются на страницы модели и не переносятся', () => {
    expect(
      modelSwitchHref(
        '/lora/library/ppv',
        { where: 'lora-2:no', sort: 'number', view: 'row' },
        'lily',
      ),
    ).toBe('/lily/library/ppv?view=row')
    expect(modelSwitchHref('/lora/journal', { area: 'plan' }, 'lily')).toBe('/lily/journal')
  })

  it('с объекта, файла, заказа, случая и группы — в корень раздела', () => {
    expect(modelSwitchHref('/lora/i/PPV-073', { page: 'lora-2' }, 'lily')).toBe('/lily/library')
    expect(modelSwitchHref('/lora/a/SET-069/ed07', {}, 'lily')).toBe('/lily/library')
    expect(modelSwitchHref('/lora/library/customs/orders/o-1', {}, 'lily')).toBe(
      '/lily/library/customs',
    )
    expect(modelSwitchHref('/lora/plan/check/t-12', {}, 'lily')).toBe('/lily/plan/check')
    expect(modelSwitchHref('/lora/inbox/g/g-2254', { view: 'list' }, 'lily')).toBe('/lily/inbox')
    expect(modelSwitchHref('/lora/library/promo/instagram/PRM-015', {}, 'lily')).toBe(
      '/lily/library/promo',
    )
  })

  it('режимы прототипа остаются при любом переходе', () => {
    expect(modelSwitchHref('/lora/i/PPV-073', { as: 'owner', demo: 'hub-down' }, 'lily')).toBe(
      '/lily/library?demo=hub-down&as=owner',
    )
  })

  it('поиск — пустой у другой модели; настройки страницы — Библиотека', () => {
    expect(modelSwitchHref('/lora/search', {}, 'lily')).toBe('/lily/search')
    expect(modelSwitchHref('/lora/settings/pages/lora-1', {}, 'lily')).toBe('/lily/library')
  })
})
