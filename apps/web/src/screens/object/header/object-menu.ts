import type { ItemId } from '@contentops/contracts'
import type { DownloadOption } from '@contentops/ui/components/download-button'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { usePromoChannels } from '@/data/promo'
import type { ObjectDialogRequest } from '@/objects/dialogs/use-object-dialogs'
import { useObjectActions } from '@/objects/use-object-actions'
import { useMakePpvDialog } from '@/shell/dialogs/make-ppv-dialog-context'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { useFileSelection } from '../files/file-selection'
import { useExtractShoot } from '../files/use-file-commands'
import { useObjectPage } from '../object-context'

const COLLECTIONS_IN_MENU = 6

/** «В промо ▾ → канал → подборка» подменю «⋯» (DESIGN §2.5): ссылками, без копий. */
function usePromoItems(onAdd: (channel: string, collection: ItemId | 'new') => void): MenuAction[] {
  const { model } = useObjectPage()
  const channels = usePromoChannels(model.code).data ?? []
  const index = useCatalogIndex(model.code).data
  return channels.map((channel) => ({
    id: `promo-${channel.id}`,
    label: channel.name,
    items: [
      {
        id: `new-${channel.id}`,
        label: 'Новая подборка',
        onSelect: () => onAdd(channel.id, 'new'),
      },
      ...(index?.items ?? [])
        .filter((entry) => entry.type === 'promo' && entry.channel === channel.id)
        .slice(0, COLLECTIONS_IN_MENU)
        .map((entry) => ({
          id: entry.id,
          label: entry.title,
          hint: entry.id,
          onSelect: () => onAdd(channel.id, entry.id),
        })),
    ],
  }))
}

/**
 * Меню «⋯» объекта (DESIGN §3.6): те же пункты, что у плитки в разделе; опасные — внизу за
 * линией. «Только чтение» видит ссылки, но не действия.
 */
export function useObjectMenu(
  downloads: readonly DownloadOption[],
  openDialog: (request: ObjectDialogRequest) => void,
): ItemMenuModel {
  const { detail, model, canAct } = useObjectPage()
  const navigate = useNavigate()
  const { openPlanDialog } = usePlanDialog()
  const { openMakePpvDialog } = useMakePpvDialog()
  const selection = useFileSelection()
  const extract = useExtractShoot()
  const entry = detail.entry
  const actions = useObjectActions(useMemo(() => [entry], [entry]))
  const promoItems = usePromoItems(actions.addToPromo)

  const links: MenuAction[] = [
    { id: 'copy', label: 'Скопировать ID', onSelect: () => void actions.copyIds() },
    {
      id: 'ydisk',
      label: 'Показать на Я.Диске ↗',
      onSelect: () => window.open(detail.ydisk.url, '_blank', 'noopener'),
    },
    {
      id: 'journal',
      label: 'Журнал объекта',
      onSelect: () =>
        void navigate({
          to: '/$model/journal',
          params: { model: model.code },
          search: { item: entry.id },
        }),
    },
  ]
  if (!canAct) {
    return { actions: links }
  }

  // У кастома, который ещё не готов для PPV (заказ не сдан или ждёт правку), «Сделать PPV»
  // уходит сюда: главная кнопка в шапке — заказ.
  const makePpvLater =
    entry.type === 'custom' &&
    !entry.photo_custom &&
    !entry.ppv_made_as &&
    !detail.ready_for_ppv &&
    !detail.ppv_montage
  const work: MenuAction[] = [
    ...(entry.type === 'custom' || entry.type === 'promo'
      ? []
      : [{ id: 'plan', label: 'В план', onSelect: () => openPlanDialog([entry.id]) }]),
    ...(makePpvLater
      ? [{ id: 'make-ppv', label: 'Сделать PPV', onSelect: () => openMakePpvDialog(entry.id) }]
      : []),
    ...(downloads.length > 0
      ? [
          {
            id: 'download',
            label: 'Скачать',
            items: downloads.map((download) => ({
              id: download.id,
              label: download.label,
              hint: download.hint,
              onSelect: () => actions.download(download.id, true),
            })),
          },
        ]
      : []),
    ...(entry.type === 'promo' ? [] : [{ id: 'promo', label: 'В промо', items: promoItems }]),
  ]
  const raw: MenuAction[] =
    entry.type === 'raw'
      ? [
          {
            id: 'merge',
            label: 'Слить с…',
            onSelect: () => openDialog({ kind: 'merge', id: entry.id }),
          },
          {
            id: 'extract',
            label: 'Выделить в новую съёмку',
            hint: selection.keys.size === 0 ? 'сначала выделите файлы' : undefined,
            disabled: selection.keys.size === 0,
            onSelect: () => extract([...selection.keys]),
          },
        ]
      : []

  return {
    actions: [...work, ...links, ...raw],
    dangerActions: [
      {
        id: 'change-type',
        label: 'Сменить тип (будет новый номер)…',
        onSelect: () => openDialog({ kind: 'change-type', id: entry.id }),
      },
      {
        id: 'delete',
        label: 'Удалить…',
        onSelect: () => openDialog({ kind: 'delete', id: entry.id }),
      },
    ],
  }
}
