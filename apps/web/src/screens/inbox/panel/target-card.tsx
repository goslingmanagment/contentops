import {
  type CatalogEntry,
  formatDuration,
  formatNumber,
  type InboxGroup,
  type ItemId,
  type ModelCode,
  type ReadyNote,
} from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { Thumb } from '@contentops/ui/components/thumb'
import { Link } from '@tanstack/react-router'
import { useCatalogIndex } from '@/data/catalog'
import { itemCover } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'

/** Заметка «готово», у которой есть цель: дополнение или исправление. */
export type TargetNote = Extract<ReadyNote, { kind: 'extends' | 'fix_of' }>

export function targetNoteOf(group: InboxGroup): TargetNote | null {
  const state = group.state
  if (state.kind !== 'ready') {
    return null
  }
  return state.note.kind === 'extends' || state.note.kind === 'fix_of' ? state.note : null
}

const TITLE: Record<TargetNote['kind'], string> = {
  extends: 'Дополнит',
  fix_of: 'Исправление',
}

/**
 * Что станет с целью: «46 фото → 49 фото» у дополнения, «мастер v1 · 3:41 → v2 · 3:38» у
 * исправления — длительность нового файла рядом с прежней (§4.8, случай «Исправление
 * кастома»).
 */
function changeText(note: TargetNote, entry: CatalogEntry, group: InboxGroup): string {
  const photos = group.files.filter((file) => file.media === 'photo').length
  if (note.kind === 'extends') {
    const before = entry.photo_count ?? 0
    return photos > 0
      ? `${formatNumber(before)} фото → ${formatNumber(before + photos)} фото`
      : `${formatNumber(before)} фото`
  }
  const master =
    group.files.find((file) => file.role === 'master') ??
    group.files.find((file) => file.media === 'video')
  const was = entry.duration_s === null ? '' : ` · ${formatDuration(entry.duration_s)}`
  const next = master?.duration_s == null ? '' : ` · ${formatDuration(master.duration_s)}`
  return `мастер v${entry.version_count}${was} → v${entry.version_count + 1}${next}`
}

/**
 * Цель группы «дополнит SET-074» и «похоже на исправление CUS-195» (§4.8): обложка, ID,
 * название и что с ней станет. Поля черновика здесь не нужны — при таком принятии они
 * не берутся; форма появляется по «Отдельным объектом» / «Принять отдельно».
 */
export function TargetCard({ group, note }: { group: InboxGroup; note: TargetNote }) {
  const current = useCurrentModel()
  const model = current.code
  const index = useCatalogIndex(model).data
  const entry = index?.items.find((candidate) => candidate.id === note.item_id)
  return (
    <InfoSection title={TITLE[note.kind]}>
      {entry ? (
        <TargetRow model={model} entry={entry} change={changeText(note, entry, group)} />
      ) : index ? (
        <p className="text-muted-foreground text-sm">{`${note.item_id} у ${current.name_genitive} нет`}</p>
      ) : (
        <Skeleton className="h-16 w-full rounded-lg" />
      )}
    </InfoSection>
  )
}

function TargetRow({
  model,
  entry,
  change,
}: {
  model: ModelCode
  entry: CatalogEntry
  change: string
}) {
  const cover = itemCover(entry)
  const id: ItemId = entry.id
  return (
    <Link
      to="/$model/i/$id"
      params={{ model, id }}
      className="-mx-1 flex min-w-0 items-center gap-3 rounded-lg p-1 transition-colors duration-120 hover:bg-accent"
    >
      <Thumb
        seed={cover.seed}
        kind={cover.kind}
        family={cover.family}
        durationSeconds={cover.durationSeconds}
        countLabel={cover.countLabel}
        versionCount={cover.versionCount}
        showCaptions={false}
        className="w-12 shrink-0 rounded-md"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-primary-ink text-sm tabular-nums">{entry.id}</span>
        <span className="truncate">{entry.title}</span>
        <span className="truncate text-muted-foreground text-sm tabular-nums">{change}</span>
      </span>
    </Link>
  )
}
