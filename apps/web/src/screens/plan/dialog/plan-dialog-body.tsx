import {
  type CatalogEntry,
  formatShortDay,
  type ItemId,
  SURFACE_LABEL,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@contentops/ui/components/tabs'
import { useState } from 'react'
import { accountOf } from '@/lib/words'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { DialogLayout } from './dialog-layout'
import { MontageFormView } from './montage-form'
import { MultiFormView } from './multi-form'
import { ObjectCard, WherePlaced } from './object-card'
import { ObjectPicker } from './object-picker'
import { ReleaseFormView } from './release-form'
import { RowFormView } from './row-form'
import { type DialogData, useDialogData } from './use-dialog-data'

interface PlanDialogBodyProps {
  items: readonly ItemId[]
  preset: PlanDialogPreset
  onDone: () => void
}

/**
 * Что показывает окно «В план» (DESIGN §4.13): поиск объекта (открыто с пустого места),
 * один объект («Строка / Выпуск PPV», у сырья — под монтаж) или несколько объектов с
 * предпросмотром раскладки.
 */
export function PlanDialogBody({ items, preset, onDone }: PlanDialogBodyProps) {
  const data = useDialogData()
  const [picked, setPicked] = useState<ItemId | null>(null)
  if (!data.ready || !data.catalog) {
    return <DialogSkeleton />
  }
  const catalog = data.catalog
  const ids = items.length > 0 ? items : picked ? [picked] : []
  const entries = ids.flatMap((id) => {
    const entry = catalog.byId.get(id)
    return entry ? [entry] : []
  })
  const title = preset.outside ? 'Выложено вне плана' : 'В план'

  const [single] = entries
  if (entries.length > 1) {
    return <MultiFormView entries={entries} data={data} preset={preset} onDone={onDone} />
  }
  if (single) {
    return (
      <SingleObject
        entry={single}
        data={data}
        preset={preset}
        title={title}
        onChange={items.length === 0 ? () => setPicked(null) : undefined}
        onDone={onDone}
      />
    )
  }
  return <PickObject data={data} preset={preset} title={title} onPick={setPicked} />
}

interface SingleObjectProps {
  entry: CatalogEntry
  data: DialogData
  preset: PlanDialogPreset
  title: string
  onChange: (() => void) | undefined
  onDone: () => void
}

function SingleObject({ entry, data, preset, title, onChange, onDone }: SingleObjectProps) {
  const [tab, setTab] = useState<'row' | 'release'>(preset.tab ?? 'row')
  const left = (
    <>
      <ObjectCard entry={entry} onChange={onChange} />
      {entry.type !== 'raw' ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-ink-3 text-sm">Где уже залито</h3>
          <WherePlaced
            accounts={data.model.accounts}
            summaries={data.summaries?.byItem.get(entry.id) ?? []}
            today={data.today}
          />
        </section>
      ) : null}
    </>
  )
  if (entry.type === 'raw') {
    return <MontageFormView entry={entry} data={data} preset={preset} left={left} onDone={onDone} />
  }
  const tabs =
    entry.type === 'ppv' && !preset.outside ? (
      <Tabs value={tab} onValueChange={(next) => setTab(next === 'release' ? 'release' : 'row')}>
        <TabsList>
          <TabsTrigger value="row">Строка</TabsTrigger>
          <TabsTrigger value="release">Выпуск PPV</TabsTrigger>
        </TabsList>
      </Tabs>
    ) : undefined
  if (tab === 'release' && tabs) {
    return (
      <ReleaseFormView
        entry={entry}
        data={data}
        preset={preset}
        tabs={tabs}
        left={left}
        onDone={onDone}
      />
    )
  }
  return (
    <RowFormView
      entry={entry}
      data={data}
      preset={preset}
      title={title}
      tabs={tabs}
      left={left}
      onDone={onDone}
    />
  )
}

interface PickObjectProps {
  data: DialogData
  preset: PlanDialogPreset
  title: string
  onPick: (id: ItemId) => void
}

/** Окно с пустого места: слева поиск с подсказками, справа — что уже подставлено. */
function PickObject({ data, preset, title, onPick }: PickObjectProps) {
  const code = preset.accounts?.[0]
  const account = code ? accountOf(data.model.accounts, code) : undefined
  const placed = [
    account?.label,
    preset.surface ? SURFACE_LABEL[preset.surface] : undefined,
    preset.date ? formatShortDay(preset.date) : undefined,
    preset.time ?? undefined,
  ].filter(Boolean)
  return (
    <DialogLayout
      title={title}
      description="Выберите объект"
      left={
        <ObjectPicker
          catalog={data.catalog?.items ?? []}
          summaries={data.summaries}
          account={account}
          surface={preset.surface}
          kind={preset.kind}
          recentFirst={preset.outside ?? false}
          onPick={onPick}
        />
      }
      check={null}
      summary=""
      submit={
        <Button type="button" disabled>
          Выберите объект
        </Button>
      }
    >
      {placed.length > 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-lg text-muted-foreground">{placed.join(' · ')}</p>
        </div>
      ) : null}
    </DialogLayout>
  )
}

/** Окно открывается мгновенно: пока индекс в пути, стоят заготовки размера колонок. */
function DialogSkeleton() {
  return (
    <DialogLayout
      title="В план"
      description="Загружается"
      left={<Skeleton className="aspect-[3/4] w-50 rounded-xl" />}
      check={null}
      summary=""
      submit={null}
    >
      <div className="flex flex-col gap-5">
        <Skeleton className="h-8 w-2/3 rounded-2xl" />
        <Skeleton className="h-9 w-1/2 rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </DialogLayout>
  )
}
