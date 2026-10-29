import { type ItemId, type ItemType, type ModelCode, mskDate } from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useClock } from '@/data/api-session'
import type { LibrarySectionSlug } from '@/screens/library/search'
import type { Destination } from './destinations'

/** Разделы-типы, у которых свой адрес `library/<раздел>`; кастомы и промо — отдельные. */
const SECTION_SLUG: Record<Exclude<ItemType, 'custom' | 'promo'>, LibrarySectionSlug> = {
  ppv: 'ppv',
  fyp: 'fyp',
  set: 'sets',
  sexting: 'sextings',
  life: 'life',
  raw: 'raw',
}

/** Переходы из поиска и меню: в раздел, папку или объект текущей модели. */
export function useGoTo() {
  const navigate = useNavigate()
  const clock = useClock()

  const goToObject = useCallback(
    (model: ModelCode, id: ItemId) => void navigate({ to: '/$model/i/$id', params: { model, id } }),
    [navigate],
  )

  const goToFolder = useCallback(
    (model: ModelCode, type: ItemType) => {
      if (type === 'custom') {
        void navigate({ to: '/$model/library/customs', params: { model } })
      } else if (type === 'promo') {
        void navigate({ to: '/$model/library/promo', params: { model } })
      } else {
        void navigate({
          to: '/$model/library/$section',
          params: { model, section: SECTION_SLUG[type] },
        })
      }
    },
    [navigate],
  )

  const goToDestination = useCallback(
    (model: ModelCode, destination: Destination) => {
      switch (destination.kind) {
        case 'folder':
          goToFolder(model, destination.type)
          return
        case 'not-uploaded':
          void navigate({ to: '/$model/library/not-uploaded', params: { model } })
          return
        case 'check':
          void navigate({ to: '/$model/plan/check', params: { model } })
          return
        case 'orders':
          void navigate({
            to: '/$model/library/customs',
            params: { model },
            search: { view: 'orders' },
          })
          return
        case 'section':
          if (destination.section === 'plan') {
            const date = mskDate(clock.now())
            void navigate({ to: '/$model/plan/$date', params: { model, date } })
          } else if (destination.section === 'inbox') {
            void navigate({ to: '/$model/inbox', params: { model } })
          } else if (destination.section === 'journal') {
            void navigate({ to: '/$model/journal', params: { model } })
          } else {
            void navigate({ to: '/$model/library', params: { model } })
          }
      }
    },
    [clock, goToFolder, navigate],
  )

  return { goToObject, goToFolder, goToDestination }
}
