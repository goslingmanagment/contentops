import { describe, expect, it } from 'vitest'
import {
  EXPORT_NAME_PATTERN,
  exportName,
  fanFileName,
  NAME_LIMIT,
  NAME_ROLES,
  normalizeExt,
  PROMO_MANIFEST_NAME,
  promoMemberName,
  slugOf,
} from './download-name'

/** Проверочные имена naming §5–6: каждый вид имени — своим тестом. */

const yoga = { id: 'FYP-0412', title: 'Йога у зеркала' }
const slot = { account: 'lora-2', date: '2026-08-27', time: '19:00' } as const

function parsed(name: string) {
  const match = EXPORT_NAME_PATTERN.exec(name)
  expect(match, name).not.toBeNull()
  return match?.groups ?? {}
}

describe('slug из названия (naming §4)', () => {
  it('предпочитает короткое английское название и удаляет английские стоп-слова', () => {
    expect(slugOf('Йога у зеркала', '  Yoga by the Mirror!  ')).toBe('yoga-mirror')
    expect(slugOf('Завтрак у окна', 'Breakfast at a Window')).toBe('breakfast-window')
    expect(slugOf('Новое русское название', 'Yoga by the Mirror')).toBe('yoga-mirror')
    expect(slugOf('Йога у зеркала', 'Yoga in a Hotel')).toBe('yoga-hotel')
  })

  it('без английского названия, в том числе пустого, сохраняет прежний транслит', () => {
    for (const title_en of [undefined, null, '', ' \t\n ']) {
      expect(slugOf('Халат у окна', title_en)).toBe('khalat-okna')
    }
    // Английские стоп-слова не меняют прежнее поведение русского названия.
    expect(slugOf('The Mirror')).toBe('the-mirror')
    expect(slugOf('Без названия', 'No Bra Mirror')).toBe('no-bra-mirror')
  })

  it('для английского сохраняет ASCII, дефисы и лимиты пяти слов и 40 знаков', () => {
    expect(slugOf('Название', '2:54, SILK — café mirror!')).toBe('silk-cafe-mirror')
    expect(slugOf('Название', 'Titfuck dildo face nipple licking extra')).toBe(
      'titfuck-dildo-face-nipple-licking',
    )
    expect(slugOf('Название', 'Stockings mirror candlelight bedroom dancing')).toBe(
      'stockings-mirror-candlelight-bedroom',
    )
    expect(slugOf('Название', 'a'.repeat(41))).toBe('a'.repeat(40))
    expect(slugOf('Название', 'The and with')).toBe('')
  })

  it('транслит по таблице нормы, слова через «-», без стоп-слов', () => {
    expect(slugOf('Завтрак у окна')).toBe('zavtrak-okna')
    expect(slugOf('Халат у окна')).toBe('khalat-okna')
    expect(slugOf('Чёрное боди, йога')).toBe('chernoe-bodi-ioga')
    expect(slugOf('Щука, цапля, юла, ящик, мышь, подъезд')).toBe('schuka-tsaplya-yula-yaschik-mysh')
  })

  it('начинается с буквы, до пяти слов и 40 знаков', () => {
    expect(slugOf('2:54 грудь попа')).toBe('grud-popa')
    expect(slugOf('Раз два три четыре пять шесть')).toBe('raz-dva-tri-chetyre-pyat')
    const long = slugOf('Длинношеее превосходительство, достопримечательность')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    expect(slugOf('15:37')).toBe('')
  })
})

describe('имя из карточки каталога (naming §6)', () => {
  it('английские имена PPV из решения 18.10.2026', () => {
    const teaser = exportName({
      id: 'PPV-005',
      title: 'Дилдо, анальная пробка',
      title_en: 'Dildo ride anal plug naked',
      role: 'teaser',
      duration_s: 14,
      ext: 'mp4',
    })
    expect(teaser).toBe('PPV-005_dildo-ride-anal-plug-naked_teaser__0m14s.mp4')
    expect(parsed(teaser)).toMatchObject({ role: 'teaser', dur: '0m14s' })

    const pic = exportName({
      id: 'PPV-011',
      title: 'Титфак, дилдо',
      title_en: 'Titfuck dildo face nipple licking',
      role: 'pic',
      ordinal: 3,
      ext: 'jpg',
    })
    expect(pic).toBe('PPV-011_titfuck-dildo-face-nipple-licking_pic03.jpg')
    expect(parsed(pic)).toMatchObject({ role: 'pic', ord: '03' })
  })

  it('ID, slug и роль; первая версия без суффикса, переделка — `_v2`', () => {
    expect(exportName({ ...yoga, role: 'master', ext: 'mp4' })).toBe(
      'FYP-0412_ioga-zerkala_master.mp4',
    )
    expect(exportName({ ...yoga, role: 'master', version: 2, ext: 'mp4' })).toBe(
      'FYP-0412_ioga-zerkala_master_v2.mp4',
    )
  })

  it('порядковая роль с номером: `ed03`', () => {
    const name = exportName({
      id: 'SET-069',
      title: 'Красное платье',
      role: 'ed',
      ordinal: 3,
      ext: 'JPG',
    })
    expect(name).toBe('SET-069_krasnoe-plate_ed03.jpg')
    expect(parsed(name)).toMatchObject({ role: 'ed', ord: '03', ext: 'jpg' })
  })

  it('длительность — у PPV и кастомов: `__13m24s`', () => {
    const name = exportName({
      id: 'PPV-073',
      title: 'День рождения, торт, кружево',
      role: 'master',
      version: 2,
      duration_s: 804,
      ext: 'mp4',
    })
    expect(name).toBe('PPV-073_den-rozhdeniya-tort-kruzhevo_master_v2__13m24s.mp4')
    expect(parsed(name)).toMatchObject({ version: '2', dur: '13m24s' })
  })
})

describe('имя из строки плана (naming §6)', () => {
  it('аккаунт, плановый день и время слота', () => {
    const name = exportName({ ...yoga, role: 'master', slot, ext: 'MOV' })
    expect(name).toBe('FYP-0412_ioga-zerkala_master__lora-2_2026-08-27_1900.mov')
    expect(parsed(name)).toMatchObject({ account: 'lora-2', date: '2026-08-27', hhmm: '1900' })
  })

  it('без времени — только день; версия, суффикс назначения и длительность вместе', () => {
    const name = exportName({
      id: 'PPV-076',
      title: 'Анал, йога',
      role: 'teaser',
      slot: { account: 'lora-1', date: '2026-08-30', time: null },
      duration_s: 401,
      ext: 'mp4',
    })
    expect(name).toBe('PPV-076_anal-ioga_teaser__lora-1_2026-08-30__6m41s.mp4')
  })

  it('подпись — sidecar роли `cap`', () => {
    expect(exportName({ ...yoga, role: 'cap', slot, ext: 'txt' })).toBe(
      'FYP-0412_ioga-zerkala_cap__lora-2_2026-08-27_1900.txt',
    )
  })
})

describe('уникальные версии фупа (naming §3)', () => {
  it('`_uN` стоит перед `_vN`', () => {
    const base = { id: 'FYP-0012', title: 'Йога у зеркала', role: 'master' as const, ext: 'mp4' }
    expect(exportName({ ...base, uniq: 2 })).toBe('FYP-0012_ioga-zerkala_master_u2.mp4')
    const remade = exportName({ ...base, uniq: 2, version: 2 })
    expect(remade).toBe('FYP-0012_ioga-zerkala_master_u2_v2.mp4')
    expect(parsed(remade)).toMatchObject({ uniq: '2', version: '2' })
  })
})

describe('промо-передача (naming §6)', () => {
  it('номер подборки, порядок, ID источника с ролью, если это не мастер', () => {
    expect(
      promoMemberName('PRM-012', 1, 3, { id: 'FYP-0412', role: 'master', ordinal: null }, 'mov'),
    ).toBe('PRM-012_01_FYP-0412.mov')
    expect(promoMemberName('PRM-012', 2, 3, { id: 'SET-069', role: 'ed', ordinal: 3 }, 'JPG')).toBe(
      'PRM-012_02_SET-069-ed03.jpg',
    )
    expect(
      promoMemberName('PRM-012', 3, 3, { id: 'PRM-012', role: 'clip', ordinal: 1 }, 'mp4'),
    ).toBe('PRM-012_03_PRM-012-clip01.mp4')
    expect(PROMO_MANIFEST_NAME).toBe('manifest.csv')
  })

  it('сто файлов и больше — номер из трёх цифр', () => {
    expect(
      promoMemberName('PRM-013', 7, 330, { id: 'RAW-0213', role: 'raw', ordinal: 3 }, 'mp4'),
    ).toBe('PRM-013_007_RAW-0213-raw03.mp4')
  })
})

describe('политики имён (naming §5)', () => {
  it('кастом для фана — нейтральное имя без ID', () => {
    expect(fanFileName('lora')).toBe('lora-custom.mp4')
  })

  it('расширение в нижнем регистре, `.jpeg` → `.jpg`, `.heic` сохраняется', () => {
    expect(normalizeExt('.MOV')).toBe('mov')
    expect(normalizeExt('JPEG')).toBe('jpg')
    expect(normalizeExt('HEIC')).toBe('heic')
  })

  it.each([undefined, 'Stockings mirror candlelight bedroom'])(
    'только допустимые знаки и не длиннее 100: slug укорачивается первым (%s)',
    (title_en) => {
      const name = exportName({
        id: 'PPV-073',
        title: 'Очень длинное название, которое никак не помещается в имя файла целиком',
        title_en,
        role: 'master',
        version: 12,
        slot: { account: 'lora-vip-of', date: '2026-09-22', time: '20:00' },
        duration_s: 3_723,
        ext: 'mp4',
      })
      expect(name.length).toBeLessThanOrEqual(NAME_LIMIT)
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(name).toMatch(/_master_v12__lora-vip-of_2026-09-22_2000__62m03s\.mp4$/)
    },
  )

  it('роль — только из закрытого словаря', () => {
    expect(NAME_ROLES).toEqual([
      'master',
      'teaser',
      'preview',
      'pic',
      'raw',
      'ed',
      'clip',
      'thumb',
      'cap',
    ])
  })
})
