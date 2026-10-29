import { type CatalogEntry, type ItemId, type ItemType, itemTypeOf } from '@contentops/contracts'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { cn } from '@contentops/ui/lib/utils'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { objectFamily } from './files/file-thumb'
import { FileTile } from './files/file-tile'
import { FilesSection } from './files/files-section'
import { IdChip } from './header/id-chip'
import { ObjectCrumbs } from './header/object-crumbs'
import { ObjectSummaryPreview } from './header/object-summary'
import { useObjectPanel } from './panel/use-object-panel'

/** Первый раздел файлов у видео: мастер — это обложка объекта (§4.5). */
const VIDEO_SECTION: Partial<Record<ItemType, string>> = {
  ppv: 'Мастер и тизер',
  custom: 'Мастер',
  fyp: 'Монтаж',
}

const MASTER_WIDTH = 148

/**
 * Шапка до ответа: крошки и ID известны из адреса, название — заготовкой, пока идёт
 * загрузка. При ошибке заготовка не мигает: вместо названия стоит сам ID.
 */
export function ObjectHeaderSkeleton({ id, failed = false }: { id: ItemId; failed?: boolean }) {
  return (
    <header className="flex h-18 shrink-0 items-center">
      <div className="flex min-w-0 flex-1 flex-col">
        <ObjectCrumbs entry={{ id, type: itemTypeOf(id) }} />
        <div className="flex h-8 items-center gap-2">
          {failed ? (
            <h1 className="font-heading text-xl tabular-nums">{id}</h1>
          ) : (
            <>
              <Skeleton className="h-6 w-18 rounded-sm" />
              <Skeleton className="h-5 w-64 rounded-sm" />
            </>
          )}
        </div>
      </div>
    </header>
  )
}

/** Шапка по записи каталога: крошки, чип ID и название на своих местах, кнопки — с карточкой. */
function ObjectHeaderPreview({ entry }: { entry: CatalogEntry }) {
  return (
    <header className="flex h-18 shrink-0 items-center">
      <div className="flex min-w-0 flex-1 flex-col">
        <ObjectCrumbs entry={entry} />
        <div className="flex h-8 min-w-0 items-center gap-2">
          <IdChip id={entry.id} />
          <h1 className="flex min-w-0 font-heading text-xl">
            <span className="truncate">{entry.title}</span>
          </h1>
        </div>
      </div>
    </header>
  )
}

/** Мастер видео — обложка из каталога той же плиткой, что придёт с карточкой. */
function CoverPreview({ entry, title }: { entry: CatalogEntry; title: string }) {
  return (
    <FilesSection title={title} className="pt-1">
      <div className="flex items-start gap-2">
        <FileTile
          cover={{ seed: entry.id, kind: entry.type, family: objectFamily(entry.id) }}
          label="мастер"
          width={MASTER_WIDTH}
          aspect="9:16"
          selected={false}
          durationSeconds={entry.duration_s ?? undefined}
          stacked={entry.version_count > 1}
          versionCount={entry.version_count}
          caption={<Skeleton className="mt-1 h-3.5 w-16 rounded-sm" />}
        />
        {entry.type === 'ppv' ? <Skeleton className="m-1 h-66 w-37" /> : null}
      </div>
    </FilesSection>
  )
}

function FilesSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 pt-1">
      <div className="flex h-7 items-center">
        <Skeleton className="h-3.5 w-28 rounded-sm" />
      </div>
      <div className="flex gap-4 p-1">
        <Skeleton className="h-66 w-37" />
        <Skeleton className="h-66 w-37" />
      </div>
    </div>
  )
}

/**
 * Первая загрузка объекта (DESIGN §3.10, §3.13): если объект уже есть в каталоге модели,
 * шапка, мета-строка, «где залито» и обложка мастера стоят сразу — из индексов в памяти
 * браузера; серые заготовки остаются только на месте того, что знает одна карточка.
 * Панель сведений держит своё место.
 */
export function ObjectSkeleton({ id, entry }: { id: ItemId; entry?: CatalogEntry }) {
  const panel = useObjectPanel()
  const videoSection =
    entry && entry.duration_s !== null && !entry.photo_custom
      ? VIDEO_SECTION[entry.type]
      : undefined
  return (
    <FieldLayout
      aside={
        panel.open ? (
          <div
            aria-hidden
            className={cn(
              'flex h-full shrink-0 flex-col gap-4 border-border border-l px-5 pt-5',
              panel.width === 'narrow' ? 'w-80' : 'w-90',
            )}
          >
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-4 w-24 rounded-sm" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-20" />
          </div>
        ) : null
      }
    >
      {entry ? (
        <>
          <ObjectHeaderPreview entry={entry} />
          <RefreshStrip active={false} />
          <ObjectSummaryPreview entry={entry} />
        </>
      ) : (
        <>
          <ObjectHeaderSkeleton id={id} />
          <RefreshStrip active={false} />
          <div aria-hidden className="flex flex-col gap-1.5 pb-3">
            <div className="flex h-4.5 items-center">
              <Skeleton className="h-3.5 w-96 max-w-full rounded-sm" />
            </div>
            <Skeleton className="h-8 w-160 max-w-full" />
          </div>
        </>
      )}
      {entry && videoSection ? (
        <CoverPreview entry={entry} title={videoSection} />
      ) : (
        <FilesSkeleton />
      )}
    </FieldLayout>
  )
}
