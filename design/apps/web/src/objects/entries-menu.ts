import type { CatalogEntry, ItemId } from '@contentops/contracts'
import type { ItemMenuModel, MenuAction } from '@contentops/ui/components/item-menu'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useApi } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { usePromoChannels } from '@/data/promo'
import { queryKeys } from '@/data/query-keys'
import { useRole } from '@/data/session'
import { type PlanDialogPreset, usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'
import type { ObjectDialogRequest } from './dialogs/use-object-dialogs'
import { downloadOptionsFor } from './download-options'
import { useObjectActions } from './use-object-actions'

const COLLECTIONS_IN_MENU = 6

/** Пункты, которые рядом уже стоят кнопками — в полосе выделения их в «⋯» нет (§3.3). */
export type EntriesMenuButton = 'open' | 'plan' | 'download' | 'promo'

interface EntriesMenuOptions {
  openDialog: (request: ObjectDialogRequest) => void
  /** Что подставить в окно «В план»: «Ещё не залито» подставляет страницу и место. */
  planPreset?: (entries: readonly CatalogEntry[]) => PlanDialogPreset
  omit?: readonly EntriesMenuButton[]
}

/**
 * «Показать на Я.Диске ↗»: адрес папки есть только в карточке объекта. Окно открывается
 * сразу по нажатию (иначе браузер сочтёт его всплывающим), адрес ставится, когда карточка
 * придёт.
 */
function useShowOnYandexDisk() {
  const model = useCurrentModel().code
  const api = useApi()
  const queryClient = useQueryClient()
  return useCallback(
    (id: ItemId) => {
      const tab = window.open('about:blank', '_blank')
      if (!tab) {
        return
      }
      tab.opener = null
      void queryClient
        .fetchQuery({
          queryKey: queryKeys.item(model, id),
          queryFn: ({ signal }) => api.objects.get({ params: { model, id }, signal }),
          staleTime: 60_000,
        })
        .then(
          (detail) => tab.location.replace(detail.ydisk.url),
          () => tab.close(),
        )
    },
    [api, model, queryClient],
  )
}

/**
 * Меню объектов Библиотеки (DESIGN §3.6, строка «Объект»; §3.3, «⋯» полосы) — один
 * список для правого клика по плитке и «⋯» полосы выделения, как `useObjectMenu` на
 * странице объекта. Пункты словами, опасные — внизу за линией. «Только чтение» видит
 * ссылки, но не действия.
 */
export function useEntriesMenu(
  entries: readonly CatalogEntry[],
  { openDialog, planPreset, omit = [] }: EntriesMenuOptions,
): ItemMenuModel {
  const model = useCurrentModel().code
  const role = useRole()
  const navigate = useNavigate()
  const { openPlanDialog } = usePlanDialog()
  const actions = useObjectActions(entries)
  const channels = usePromoChannels(model).data ?? []
  const index = useCatalogIndex(model).data
  const showOnDisk = useShowOnYandexDisk()
  const canAct = role === 'owner' || role === 'manager'
  const single = entries.length === 1 ? entries[0] : undefined
  const ids = entries.map((entry) => entry.id)
  const onlyPromo = entries.length > 0 && entries.every((entry) => entry.type === 'promo')
  const shows = (button: EntriesMenuButton) => !omit.includes(button)

  const open: MenuAction[] =
    single && shows('open')
      ? [
          {
            id: 'open',
            label: 'Открыть',
            onSelect: () =>
              void navigate({ to: '/$model/i/$id', params: { model, id: single.id } }),
          },
        ]
      : []

  const work: MenuAction[] = canAct
    ? [
        ...(shows('plan') && !onlyPromo
          ? [
              {
                id: 'plan',
                label: 'В план',
                onSelect: () => openPlanDialog(ids, planPreset?.(entries)),
              },
            ]
          : []),
        ...(shows('download')
          ? [
              {
                id: 'download',
                label: 'Скачать',
                items: downloadOptionsFor(entries).map((option) => ({
                  id: option.id,
                  label: option.label,
                  hint: option.hint,
                  onSelect: () => actions.download(option.id, true),
                })),
              },
            ]
          : []),
        ...(shows('promo') && !onlyPromo && channels.length > 0
          ? [
              {
                id: 'promo',
                label: 'В промо',
                items: channels.map((channel) => ({
                  id: `promo-${channel.id}`,
                  label: channel.name,
                  items: [
                    {
                      id: `new-${channel.id}`,
                      label: 'Новая подборка',
                      onSelect: () => actions.addToPromo(channel.id, 'new'),
                    },
                    ...(index?.items ?? [])
                      .filter((entry) => entry.type === 'promo' && entry.channel === channel.id)
                      .slice(0, COLLECTIONS_IN_MENU)
                      .map((entry) => ({
                        id: entry.id,
                        label: entry.title,
                        hint: entry.id,
                        onSelect: () => actions.addToPromo(channel.id, entry.id),
                      })),
                  ],
                })),
              },
            ]
          : []),
        {
          id: 'tags',
          label: 'Теги…',
          onSelect: () => openDialog({ kind: 'tags', entries }),
        },
        {
          id: 'second-person',
          label: 'Второй человек в кадре…',
          onSelect: () => openDialog({ kind: 'second-person', items: ids }),
        },
      ]
    : []

  const links: MenuAction[] = [
    { id: 'copy', label: 'Скопировать ID', onSelect: () => void actions.copyIds() },
    ...(single
      ? [
          {
            id: 'ydisk',
            label: 'Показать на Я.Диске ↗',
            onSelect: () => showOnDisk(single.id),
          },
          {
            id: 'journal',
            label: 'Журнал объекта',
            onSelect: () =>
              void navigate({
                to: '/$model/journal',
                params: { model },
                search: { item: single.id },
              }),
          },
        ]
      : []),
  ]

  const raw: MenuAction[] =
    canAct && single?.type === 'raw'
      ? [
          {
            id: 'merge',
            label: 'Слить с…',
            onSelect: () => openDialog({ kind: 'merge', id: single.id }),
          },
        ]
      : []

  return {
    actions: [...open, ...work, ...links, ...raw],
    dangerActions:
      canAct && single
        ? [
            {
              id: 'change-type',
              label: 'Сменить тип (будет новый номер)…',
              onSelect: () => openDialog({ kind: 'change-type', id: single.id }),
            },
            {
              id: 'delete',
              label: 'Удалить…',
              onSelect: () => openDialog({ kind: 'delete', id: single.id }),
            },
          ]
        : undefined,
  }
}
