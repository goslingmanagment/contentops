import { beforeAll, describe, expect, it } from 'vitest'
import { type DialogTestWorld, loadDialogTestWorld } from './dialog-test-world'
import {
  allowedSurfaces,
  alreadyThere,
  blockedReason,
  commonSurfaces,
  defaultPages,
  defaultSurface,
  normExpects,
  normTime,
  pageBlockReason,
} from './rules'

let world: DialogTestWorld

beforeAll(async () => {
  world = await loadDialogTestWorld()
})

function account(code: string) {
  const found = world.accounts.find((candidate) => candidate.code === code)
  if (!found) {
    throw new Error(`нет страницы ${code}`)
  }
  return found
}

describe('места по типу и платформе (DESIGN §4.13)', () => {
  it('фупов на OnlyFans нет, сырьё и промо не ставятся никуда', () => {
    expect(allowedSurfaces('fyp', 'fansly')).toEqual(['fyp'])
    expect(allowedSurfaces('fyp', 'onlyfans')).toEqual([])
    expect(allowedSurfaces('raw')).toEqual([])
    expect(allowedSurfaces('promo')).toEqual([])
    expect(allowedSurfaces('ppv')).toEqual(['wall', 'vault', 'story', 'dm'])
  })

  it('у нескольких объектов — только общие места, в порядке окна', () => {
    expect(commonSurfaces(['ppv', 'set'])).toEqual(['wall', 'story'])
    expect(commonSurfaces(['ppv', 'fyp'])).toEqual([])
    expect(commonSurfaces(['life', 'life'])).toEqual(['wall', 'vault', 'story'])
  })

  it('место по умолчанию: бандл — стена, сет — стена, фуп — фуп', () => {
    expect(defaultSurface(world.entry('PPV-076'))).toBe('wall')
    expect(defaultSurface(world.entry('SET-074'))).toBe('wall')
    expect(defaultSurface(world.entry('FYP-0801'))).toBe('fyp')
  })
})

describe('норма страницы', () => {
  it('время и ожидание места по норме §9.6', () => {
    expect(normTime(world.norms, 'lora-1', 'fyp')).toBe('03:00')
    expect(normTime(world.norms, 'lora-1', 'wall')).toBe('20:00')
    expect(normTime(world.norms, 'lora-of', 'wall')).toBe('19:00')
    expect(normExpects(world.norms, 'lora-2', 'fyp')).toBe(true)
    expect(normExpects(world.norms, 'lora-vip-of', 'fyp')).toBe(false)
    expect(normExpects(world.norms, 'lora-1', 'vault')).toBe(true)
  })
})

describe('жёсткое правило и серые страницы', () => {
  it('второй человек в кадре не идёт на OnlyFans, на Fansly — идёт', () => {
    const duo = world.entry('PPV-085')
    expect(blockedReason(duo, account('lora-vip-of'))).toBe('нельзя: второй человек в кадре')
    expect(blockedReason(duo, account('lora-2'))).toBeNull()
    expect(pageBlockReason([duo], account('lora-of'), 'wall')).toBe(
      'нельзя: второй человек в кадре',
    )
  })

  it('фуп на странице OnlyFans серый со своей причиной', () => {
    expect(pageBlockReason([world.entry('FYP-0801')], account('lora-vip-of'), 'fyp')).toBe(
      'фупов на OnlyFans нет',
    )
    expect(pageBlockReason([world.entry('FYP-0801')], account('lora-2'), 'fyp')).toBeNull()
  })
})

describe('страницы по умолчанию: по норме и где объекта ещё нет', () => {
  it('SET-074 в планировщике на Fansly 1–3 — отмечены только OF VIP и OF Free', () => {
    const pages = defaultPages({
      entry: world.entry('SET-074'),
      accounts: world.accounts,
      surface: 'wall',
      norms: world.norms,
      summaries: world.summaries('SET-074'),
    })
    expect(pages).toEqual(['lora-vip-of', 'lora-of'])
  })

  it('PPV-076 стоит выпуском на всех пяти — на стену не отмечено ничего', () => {
    const summaries = world.summaries('PPV-076')
    expect(summaries.every((summary) => alreadyThere(summary, 'wall'))).toBe(true)
    expect(
      defaultPages({
        entry: world.entry('PPV-076'),
        accounts: world.accounts,
        surface: 'wall',
        norms: world.norms,
        summaries,
      }),
    ).toEqual([])
  })

  it('без сводки (не пришла) отмечались бы все страницы по норме — окно ждёт её', () => {
    const pages = defaultPages({
      entry: world.entry('SET-074'),
      accounts: world.accounts,
      surface: 'wall',
      norms: world.norms,
      summaries: [],
    })
    expect(pages).toHaveLength(5)
  })
})
