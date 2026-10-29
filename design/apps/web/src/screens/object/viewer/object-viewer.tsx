import { formatBytes, formatDuration, type ItemDetail } from '@contentops/contracts'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { ToggleGroup, ToggleGroupItem } from '@contentops/ui/components/toggle-group'
import { Viewer, type ViewerCompare } from '@contentops/ui/components/viewer'
import { useMemo } from 'react'
import { useToday } from '@/data/api-session'
import { useObjectActions } from '@/objects/use-object-actions'
import { objectDownloadOptions } from '../header/download-options'
import { objectMetaParts } from '../header/object-meta'
import { useObjectPage } from '../object-context'
import { type ObjectSearch, viewerKeyOf } from '../search'
import { masterVersionFile, type ViewerEntry, viewerEntries } from './viewer-files'

/**
 * Просмотр объекта (DESIGN §3.5, §4.6): чёрный экран, стрелки листают файлы объекта, у
 * видео — дорожка хронологии и старт с кадра или найденной минуты, у кастома и PPV после
 * правки — «v1 / v2» внизу слева, сравнение двух версий лентами кадров. Всё — в адресе.
 */
export function ObjectViewer() {
  const { detail, search } = useObjectPage()
  const entries = useMemo(() => viewerEntries(detail, search), [detail, search])
  const viewKey = viewerKeyOf(search)
  const index = entries.findIndex((entry) => entry.key === viewKey)
  const entry = entries[index]
  if (viewKey === undefined || !entry) {
    return null
  }
  return (
    <OpenViewer detail={detail} search={search} entries={entries} index={index} entry={entry} />
  )
}

interface OpenViewerProps {
  detail: ItemDetail
  search: ObjectSearch
  entries: readonly ViewerEntry[]
  index: number
  entry: ViewerEntry
}

function OpenViewer({ detail, search, entries, index, entry }: OpenViewerProps) {
  const { canAct, setSearch, closeViewer, model } = useObjectPage()
  const actions = useObjectActions(useMemo(() => [detail.entry], [detail.entry]))
  const downloads = useMemo(() => objectDownloadOptions(detail, model.code), [detail, model.code])
  const master = detail.files.find((file) => file.role === 'master')
  const isMaster = entry.key === 'master'
  const versionCount = master?.versions.length ?? 0
  const version = isMaster ? (search.v ?? master?.current_version) : undefined
  const shown =
    isMaster && version !== undefined
      ? (masterVersionFile(detail, version) ?? entry.file)
      : entry.file
  const compare = useCompare(detail, search)
  const timeline = isMaster ? timelineOf(detail) : undefined
  const processing = master?.state.kind === 'processing' && isMaster ? master.state : null

  const caption =
    isMaster && version !== undefined && versionCount > 1
      ? masterCaption(version, shown.durationSeconds)
      : entry.caption

  return (
    <Viewer
      open
      onOpenChange={(open) => !open && closeViewer()}
      title={`${detail.entry.id} · ${compare ? 'сравнение v1 / v2' : caption}`}
      files={entries.map((candidate) => (candidate.key === entry.key ? shown : candidate.file))}
      index={index}
      onIndexChange={(next) => {
        const target = entries[next]
        if (target) {
          setSearch({ view: target.key, t: undefined, v: undefined }, { replace: true })
        }
      }}
      startSeconds={search.t}
      timeline={timeline}
      compare={compare}
      onCompareOpenAt={(file, seconds) =>
        setSearch(
          {
            compare: undefined,
            view: 'master',
            t: seconds,
            v: file === compare?.left ? 1 : undefined,
          },
          { replace: true },
        )
      }
      previewProgress={
        processing && processing.progress !== null ? processing.progress * 100 : undefined
      }
      actions={
        canAct && downloads.length > 0 ? (
          <DownloadButton variant="bar" options={downloads} onDownload={actions.download} />
        ) : undefined
      }
      info={<ViewerInfo detail={detail} entry={entry} />}
      corner={
        isMaster && versionCount > 1 && !compare ? (
          <VersionSwitch
            count={versionCount}
            value={version ?? versionCount}
            onChange={(next) =>
              setSearch(
                { v: next === master?.current_version ? undefined : next },
                { replace: true },
              )
            }
          />
        ) : undefined
      }
    />
  )
}

/** «мастер v2 · 13:24»: версия, которая сейчас в просмотре. */
function masterCaption(version: number, seconds: number | undefined): string {
  return seconds === undefined
    ? `мастер v${version}`
    : `мастер v${version} · ${formatDuration(seconds)}`
}

function useCompare(detail: ItemDetail, search: ObjectSearch): ViewerCompare | undefined {
  return useMemo(() => {
    if (search.compare !== 'v1,v2') {
      return undefined
    }
    const left = masterVersionFile(detail, 1)
    const right = masterVersionFile(detail, 2)
    return left && right ? { left, right, leftLabel: 'v1', rightLabel: 'v2' } : undefined
  }, [detail, search.compare])
}

function timelineOf(detail: ItemDetail) {
  const field = detail.markup.find((candidate) => candidate.field.key === 'timeline')?.field
  if (field?.key !== 'timeline' || field.value.length === 0) {
    return undefined
  }
  return field.value.map((segment) => ({ start: segment.start_s, label: segment.label }))
}

function VersionSwitch({
  count,
  value,
  onChange,
}: {
  count: number
  value: number
  onChange: (version: number) => void
}) {
  const versions = Array.from({ length: count }, (_, index) => index + 1)
  return (
    <ToggleGroup
      type="single"
      variant="segment"
      aria-label="Версия мастера"
      value={String(value)}
      onValueChange={(next) => next && onChange(Number(next))}
    >
      {versions.map((version) => (
        <ToggleGroupItem key={version} value={String(version)} className="px-3 text-sm">
          v{version}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Сведения справа тёмной панелью 320 (клавиша `i`): мета-строка и сам файл. */
function ViewerInfo({ detail, entry }: { detail: ItemDetail; entry: ViewerEntry }) {
  const today = useToday()
  const file = detail.files.find((candidate) => candidate.key === entry.key)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-base">{detail.entry.title}</p>
      <p className="text-muted-foreground">{objectMetaParts(detail, today).join(' · ')}</p>
      {file ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-ink-3">Файл</dt>
          <dd className="break-all font-mono text-xs">{file.file_name}</dd>
          <dt className="text-ink-3">Размер</dt>
          <dd className="tabular-nums">
            {formatBytes(file.size_bytes)} · {file.width} × {file.height}
          </dd>
        </dl>
      ) : null}
    </div>
  )
}
