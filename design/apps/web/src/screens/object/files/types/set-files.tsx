import { formatNumber, type ItemFile } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { cn } from '@contentops/ui/lib/utils'
import { CheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useObjectPage } from '../../object-context'
import type { SetFramesView } from '../../search'
import type { GridKeyAction } from '../file-grid'
import { FilesScroll } from '../files-scroll'
import { byKey, byPosition } from '../ordered-files'
import { PhotosSection } from '../photos-section'
import { SegmentSwitch } from '../segment-switch'
import { usePickFrames } from '../use-file-commands'

const PICK_CODES: Record<string, boolean | undefined> = {
  Digit1: true,
  Numpad1: true,
  Digit3: false,
  Numpad3: false,
}

/** Отбор, пока сервер не ответил: галочка уже стоит, но бледная (DESIGN §3.13, п. 6). */
function useOptimisticPicks(version: number) {
  const [picks, setPicks] = useState<Readonly<Record<string, boolean>>>({})
  useEffect(() => {
    if (version) {
      setPicks({})
    }
  }, [version])
  return [
    picks,
    (key: string, picked: boolean) => setPicks((current) => ({ ...current, [key]: picked })),
  ] as const
}

/**
 * «Отобран» — белая галочка на тёмной пилюле, как метки на миниатюре. Синяя рамка
 * с галочкой остаётся только у выделения: отбор и выделение не путаются.
 */
function PickedMark({ picked, pending }: { picked: boolean; pending: boolean }) {
  if (!picked) {
    return null
  }
  return (
    <span
      role="img"
      aria-label="отобран"
      title="Отобран"
      className={cn(
        'flex h-5 items-center rounded-full bg-scrim px-1.5 text-scrim-foreground transition-opacity duration-120',
        pending && 'opacity-50',
      )}
    >
      <CheckIcon aria-hidden className="size-3.5" strokeWidth={2.5} />
    </span>
  )
}

function processedMark(file: ItemFile) {
  return file.processed ? <Badge variant="scrim">обр.</Badge> : null
}

/**
 * Сет (DESIGN §4.5): «Все кадры · 46 / Отобранные · 21». В «Все» `1` отбирает кадр, `3`
 * убирает, фокус идёт дальше. В «Отобранные» — номера и порядок перетаскиванием;
 * обработанный кадр лежит на исходном с меткой «обр.».
 */
export function SetFiles() {
  const { detail, search, setSearch, canAct } = useObjectPage()
  const view: SetFramesView = search.frames ?? 'all'
  const frames = detail.files.filter((file) => file.role === 'photo')
  const all = byKey(frames)
  const picked = byPosition(frames.filter((file) => file.selected))
  const pick = usePickFrames()
  const [optimistic, markOptimistic] = useOptimisticPicks(detail.version)

  const isPicked = (file: ItemFile) => optimistic[file.key] ?? file.selected === true

  const onKeyAction: GridKeyAction = (event, index, focusNext) => {
    const selected = PICK_CODES[event.code]
    const file = all[index]
    if (!canAct || selected === undefined || !file) {
      return false
    }
    markOptimistic(file.key, selected)
    pick([file.key], selected)
    focusNext()
    return true
  }

  const toggle = (
    <SegmentSwitch
      label="Какие кадры"
      value={view}
      onChange={(next) =>
        setSearch({ frames: next === 'all' ? undefined : next }, { replace: true })
      }
      segments={[
        { value: 'all', label: `Все кадры · ${formatNumber(all.length)}` },
        { value: 'picked', label: `Отобранные · ${formatNumber(picked.length)}` },
      ]}
    />
  )

  return (
    <FilesScroll>
      {view === 'all' ? (
        <PhotosSection
          title="Кадры"
          files={all}
          action={toggle}
          corner={(file) => <PickedMark picked={isPicked(file)} pending={file.key in optimistic} />}
          marks={processedMark}
          onKeyAction={onKeyAction}
        />
      ) : (
        <PhotosSection
          title="Отобранные"
          note="в порядке для заливки"
          files={picked}
          action={toggle}
          numbered
          sortable
          marks={processedMark}
          empty={
            <p className="py-6 text-muted-foreground">
              Ничего не отобрано · в «Все кадры» клавиша 1 отбирает кадр
            </p>
          }
        />
      )}
    </FilesScroll>
  )
}
