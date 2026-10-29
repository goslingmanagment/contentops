import {
  CalendarPlusIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  HistoryIcon,
  MegaphoneIcon,
} from 'lucide-react'
import type { DownloadOption } from '../../src/components/download-button'
import type { ItemMenuModel } from '../../src/components/item-menu'
import type { PlacementEntry } from '../../src/components/placement-line'

const noop = () => undefined

/** Меню объекта (DESIGN §3.6). */
export const objectMenu: ItemMenuModel = {
  actions: [
    { id: 'open', label: 'Открыть', onSelect: noop },
    { id: 'plan', label: 'В план', icon: CalendarPlusIcon, onSelect: noop },
    {
      id: 'download',
      label: 'Скачать',
      icon: DownloadIcon,
      items: [
        {
          id: 'upload-copy',
          label: 'Для заливки',
          hint: 'копия для платформы · готова, 18 МБ',
          onSelect: noop,
        },
        {
          id: 'master',
          label: 'Мастер (для монтажа)',
          hint: '1,1 ГБ · 2160 × 3840 · CapCut открывает',
          onSelect: noop,
        },
      ],
    },
    {
      id: 'promo',
      label: 'В промо',
      icon: MegaphoneIcon,
      items: [
        { id: 'instagram', label: 'Instagram', onSelect: noop },
        { id: 'reddit', label: 'Reddit', onSelect: noop },
      ],
    },
    { id: 'copy-id', label: 'Скопировать ID', icon: CopyIcon, onSelect: noop },
    { id: 'disk', label: 'Показать на Я.Диске ↗', icon: ExternalLinkIcon, onSelect: noop },
    { id: 'journal', label: 'Журнал объекта', icon: HistoryIcon, onSelect: noop },
  ],
  dangerActions: [
    { id: 'change-type', label: 'Сменить тип (будет новый номер)…', onSelect: noop },
    { id: 'delete', label: 'Удалить…', onSelect: noop },
  ],
}

/** Варианты «Скачать ▾» у видео (DESIGN §4.4). */
export const downloadOptions: readonly DownloadOption[] = [
  {
    id: 'upload-copy',
    label: 'Для заливки',
    hint: 'копия для платформы · готова, 18 МБ',
    fileName: 'PPV-073_birthday_master__lora-1_2026-08-07_2000__13m24s.mp4',
  },
  { id: 'master', label: 'Мастер (для монтажа)', hint: '1,1 ГБ · 2160 × 3840 · CapCut открывает' },
  {
    id: 'anywhere',
    label: 'Копия, которая откроется везде',
    hint: 'соберётся по запросу, не хранится',
  },
  { id: 'photos', label: 'Фото 100 % · 21', hint: 'исходники фото' },
]

/** «Где залито» у PPV-073 (DESIGN §9.3). */
export const ppv073Placement: readonly PlacementEntry[] = [
  { page: 'Fansly 1', sign: 'done', text: '07.08' },
  { page: 'Fansly 2', sign: 'done', text: '08.08' },
  { page: 'Fansly 3', sign: 'turn', text: 'сверить' },
  { page: 'OF VIP', text: 'отмечено 09.08' },
  { page: 'OF Free', text: 'не видели' },
]
