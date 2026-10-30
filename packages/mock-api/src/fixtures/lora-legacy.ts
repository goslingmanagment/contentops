import type { ThumbRef } from '@contentops/contracts/domain/common'
import type {
  Dispute,
  DisputeKind,
  DisputeOption,
  LegacyReview,
} from '@contentops/contracts/domain/legacy'

/** «Разбор старого» of Лора (DESIGN §9.5): 973 of 1 200 folders, 38 disputed cases. */

const thumb = (key: string): ThumbRef => ({ key: `legacy:${key}`, ratio: '3:4' })

const NUMBER_OPTIONS: DisputeOption[] = [
  { key: 'keep', label: 'оставить' },
  { key: 'new_number', label: 'новый номер' },
  { key: 'typo', label: 'опечатка' },
  { key: 'unclear', label: 'неясно — оставить в разборе' },
]

function dispute(
  id: string,
  kind: DisputeKind,
  root: string,
  title: string,
  patch: Partial<Omit<Dispute, 'id' | 'kind' | 'root' | 'title'>> = {},
): Dispute {
  return {
    id,
    kind,
    root,
    title,
    fragment: null,
    thumbs: [],
    label: null,
    folders: [],
    proposal: null,
    options: [],
    postponed: null,
    resolved: null,
    ...patch,
  }
}

/** «Номер занят»: папки с одним номером; первая по норме оставляет его, остальные — новые. */
function numberTaken(number: string, names: readonly string[], proposal: string): Dispute {
  const folders = names.map((name, index) => ({
    name: `[${number}]_${name}`,
    thumb: thumb(`${number.toLowerCase()}-${name}`),
    proposal: index === 0 ? 'keep' : 'new_number',
  }))
  const count = names.length === 2 ? 'двух' : 'трёх'
  return dispute(`d-${number.toLowerCase()}`, 'number_taken', 'PPV', `${number} у ${count} папок`, {
    fragment: folders.map((folder) => folder.name).join(' · '),
    thumbs: folders.map((folder) => folder.thumb),
    folders,
    proposal,
    options: NUMBER_OPTIONS,
  })
}

function ppvDisputes(): Dispute[] {
  return [
    numberTaken(
      'PPV-032',
      ['milk', 'halloween', 'brown_set'],
      'milk оставляет 032, halloween и brown_set получают новые номера',
    ),
    numberTaken('PPV-023', ['bodyart', 'tie'], 'bodyart оставляет 023, tie получает новый номер'),
    dispute('d-ppv-066', 'number_typo', 'PPV', '[PPV-066]_shimmer — в реестре 067', {
      fragment: '[PPV-066]_shimmer_Teasing_5min_10.04.2026',
      thumbs: [thumb('ppv-066-shimmer')],
      proposal: 'PPV-067',
      options: NUMBER_OPTIONS,
    }),
  ]
}

function sextingDisputes(): Dispute[] {
  return ['SXT-010', 'SXT-011'].map((id) =>
    dispute(`d-${id.toLowerCase()}`, 'number_no_trace', 'Секстинги', `${id}: следов нет`, {
      options: [
        { key: 'leave_empty', label: 'Оставить пустыми' },
        { key: 'reserve', label: 'Резерв по находке…' },
      ],
    }),
  )
}

function customDisputes(): Dispute[] {
  const fromCustom = (ppv: string, custom: string) =>
    dispute(
      `d-${ppv.toLowerCase()}`,
      'ppv_from_custom',
      'Кастомы',
      `${ppv} ← ${custom}: совпали байты`,
      {
        thumbs: [thumb(ppv), thumb(custom)],
        options: [
          { key: 'confirm', label: 'Подтвердить связь' },
          { key: 'reject', label: 'Нет связи' },
        ],
      },
    )
  const crossModel = (index: number) =>
    dispute(`d-cross-cus-${index}`, 'cross_model', 'Кастомы', 'есть у Ари', {
      fragment: `3. Customs / ${index === 1 ? '5:24 нейлон.mov' : '6:03 после душа.mov'}`,
      options: [{ key: 'check', label: 'Проверить' }],
    })
  return [
    fromCustom('PPV-061', 'CUS-044'),
    fromCustom('PPV-058', 'CUS-031'),
    fromCustom('PPV-049', 'CUS-022'),
    crossModel(1),
    crossModel(2),
  ]
}

/** Страница по метке — как в карточке «Метки → страницы» этой модели. */
const ACCOUNT_BY_LABEL: Readonly<Record<string, string>> = {
  used1: 'Fansly 1',
  used2: 'Fansly 2',
  used3: 'Fansly 3',
}

/**
 * «Привязать к Fansly 3, 04.08.26»: дата — часть имени вида ДД.ММ(.ГГ), остальное число —
 * номер поста дня («used3_2_27.08» → «Fansly 3, 27.08 · пост 2»).
 */
export function bindProposal(name: string): string {
  const [label = '', ...rest] = name.split('_')
  const account = ACCOUNT_BY_LABEL[label] ?? label
  const date = rest.find((part) => /^\d{2}\.\d{2}(\.\d{2})?$/.test(part))
  const post = rest.find((part) => /^\d{1,2}$/.test(part))
  return [`Привязать к ${account}${date ? `, ${date}` : ''}`, post ? `пост ${post}` : null]
    .filter(Boolean)
    .join(' · ')
}

function fypDisputes(): Dispute[] {
  const labels = [
    'used3_04.08.26',
    'used2_18.06.26',
    'used1_16.11.25',
    'used3_2_27.08',
    'used2_31.07.26',
  ]
  return Array.from({ length: 14 }, (_, index) => {
    const name = labels[index % labels.length] ?? 'used1'
    const label = name.split('_')[0] ?? name
    const fyp = `FYP-0${331 + index * 7}`
    return dispute(`d-label-${index + 1}`, 'label_from_name', 'FYP', `${name} · ${fyp}`, {
      fragment: `${name}.mov`,
      thumbs: [thumb(fyp)],
      label,
      proposal: bindProposal(name),
      options: [
        { key: 'bind', label: `Привязать к ${ACCOUNT_BY_LABEL[label] ?? label}` },
        { key: 'ignore', label: 'Игнорировать' },
      ],
    })
  })
}

function otherDisputes(): Dispute[] {
  const shortShoots = ['21.07', '28.07', '03.08', '11.08', '19.08', '02.09'].map((day, index) =>
    dispute(`d-short-${index + 1}`, 'short_shoot', 'Остальное', `Сырьё из 1 файла · ${day}`, {
      fragment: `8. Other / IMG_${1600 + index * 13}.MOV`,
      thumbs: [thumb(`short-${index + 1}`)],
      options: [
        { key: 'merge', label: 'Слить с соседней' },
        { key: 'keep', label: 'Оставить' },
      ],
    }),
  )
  const pictures = [
    'IMG_1562(used1).JPG',
    'IMG_1577(used2).JPG',
    'IMG_1590(used1).JPG',
    'IMG_1603(used3).JPG',
    'IMG_1611(used1).JPG',
  ].map((name, index) => {
    // «(used1)» в имени — та же метка, что в карточке: предложение берётся по ней.
    const label = /\((used\d)\)/.exec(name)?.[1] ?? 'used1'
    return dispute(
      `d-picture-${index + 1}`,
      'label_from_name',
      'Остальное',
      `${name} · 7. Pictures`,
      {
        fragment: `7. Pictures / ${name}`,
        thumbs: [thumb(`picture-${index + 1}`)],
        label,
        proposal: bindProposal(label),
        options: [
          { key: 'bind', label: 'Привязать к странице' },
          { key: 'ignore', label: 'Игнорировать' },
        ],
      },
    )
  })
  return [
    ...shortShoots,
    ...pictures,
    dispute('d-archive-feb', 'archive_broken', 'Архивы', '«sexting feb.zip» не читается', {
      fragment: 'sexting feb.zip',
      options: [
        { key: 'retry', label: 'Повторить' },
        { key: 'manual', label: 'Разобрать вручную' },
      ],
    }),
    dispute('d-archive-ari', 'foreign_archive', 'Архивы', '6,5 ГБ · Ари', {
      fragment: 'ari_backup.zip',
      postponed: 'Отложено до подключения Ари',
    }),
    dispute('d-cross-other', 'cross_model', 'Остальное', 'есть у Ари', {
      fragment: '8. Other / IMG_1498.JPG',
      options: [{ key: 'check', label: 'Проверить' }],
    }),
  ]
}

export function buildLoraLegacy(): LegacyReview {
  return {
    progress: {
      processed_folders: 973,
      total_folders: 1200,
      old_names: 30,
      unresolved: 0,
      stalled: null,
      roots: [
        { root: 'PPV', accepted: 74, old_names: 3, disputed: 3, waiting: 0 },
        { root: 'Секстинги', accepted: 10, old_names: 2, disputed: 2, waiting: 0 },
        { root: 'Сеты', accepted: 61, old_names: 4, disputed: 0, waiting: 12 },
        { root: 'Кастомы', accepted: 188, old_names: 9, disputed: 5, waiting: 0 },
        { root: 'FYP', accepted: 640, old_names: 12, disputed: 14, waiting: 120 },
        {
          root: 'Остальное, SMM, Архивы, «Старый формат»',
          accepted: null,
          old_names: null,
          disputed: 14,
          waiting: null,
        },
      ],
    },
    labels: [
      {
        label: 'used1',
        examples: [{ name: 'used1_16.11.25.mov', thumb: thumb('used1') }],
        target: { kind: 'accounts', accounts: ['lora-1'] },
      },
      {
        label: 'used2',
        examples: [{ name: 'used2_31.07.26.mov', thumb: thumb('used2') }],
        target: { kind: 'accounts', accounts: ['lora-2'] },
      },
      {
        label: 'used3',
        examples: [{ name: 'used3_04.08.26.mov', thumb: thumb('used3') }],
        target: { kind: 'accounts', accounts: ['lora-3'] },
      },
      {
        label: 'posted',
        examples: [{ name: 'Posted/Август (posted)/05.08.mov', thumb: thumb('posted') }],
        target: { kind: 'accounts', accounts: ['lora-1'] },
      },
      {
        label: 'used_all',
        examples: [{ name: 'set_на_столе_09.07.25(used_all)', thumb: thumb('used_all') }],
        target: { kind: 'accounts', accounts: ['lora-1', 'lora-2', 'lora-3'] },
      },
      { label: 'K', examples: [{ name: 'K2_05.08.mov', thumb: thumb('k') }], target: null },
    ],
    disputes: [
      ...ppvDisputes(),
      ...sextingDisputes(),
      ...customDisputes(),
      ...fypDisputes(),
      ...otherDisputes(),
    ],
  }
}
