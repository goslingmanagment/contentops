import { type DraftFile, type FileRole, formatNumber, type InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FileGrid } from '@contentops/ui/components/file-grid'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { DownloadIcon } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useState } from 'react'
import { groupKind } from '../shared/draft-cover'
import type { IntakeActions } from '../shared/use-intake-actions'
import { ArchiveContents } from './archive-contents'
import { FileTile } from './file-tile'

/** Плитка файла черновика 72 × 96 и ряд с промежутком (DESIGN §4.8). */
const TILE_WIDTH = 72
const TILE_HEIGHT = 96

type PhotoOrder = 'name' | 'shot'

const fileKey = (file: DraftFile) => file.key

/** Фото по имени или по времени съёмки; видео и прочее остаются впереди, как были. */
function orderedKeys(files: readonly DraftFile[], by: PhotoOrder): string[] {
  const photos = files.filter((file) => file.role === 'photo')
  const others = files.filter((file) => file.role !== 'photo')
  const sorted = photos.toSorted((left, right) =>
    by === 'name'
      ? left.file_name.localeCompare(right.file_name, 'ru', { numeric: true })
      : (left.shot_at ?? '').localeCompare(right.shot_at ?? ''),
  )
  return [...others, ...sorted].map((file) => file.key)
}

interface DraftFilesProps {
  group: InboxGroup
  actions: IntakeActions
  scrollRef: RefObject<HTMLElement | null>
}

/**
 * Файлы группы (DESIGN §4.8, п. 4): плитки 72 × 96 с чипом роли, порядок перетаскиванием
 * и «По имени / По времени съёмки», галочки — для «Выделить в новую», «Скачать исходник».
 * Порядок на экране меняется сразу, «Сохранено» — после ответа.
 */
export function DraftFiles({ group, actions, scrollRef }: DraftFilesProps) {
  const kind = groupKind(group)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [localOrder, setLocalOrder] = useState<readonly string[] | null>(null)

  useEffect(() => {
    setChecked(new Set())
  }, [group.id])
  useEffect(() => {
    setLocalOrder(null)
  }, [group.version])

  const files = useMemo(() => {
    if (!localOrder) {
      return group.files
    }
    const byKey = new Map(group.files.map((file) => [file.key, file]))
    return localOrder.flatMap((key) => byKey.get(key) ?? [])
  }, [group.files, localOrder])

  const currentOrder = group.files.map((file) => file.key)
  const reorder = (order: string[]) => {
    setLocalOrder(order)
    actions.files(group, { order }, { order: currentOrder })
  }
  const changeRole = (file: DraftFile, role: FileRole) =>
    actions.files(
      group,
      { roles: [{ key: file.key, role }] },
      { roles: [{ key: file.key, role: file.role }] },
    )
  const setFileChecked = (key: string, value: boolean) =>
    setChecked((previous) => {
      const next = new Set(previous)
      if (value) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })

  const renderFile = (file: DraftFile) => (
    <FileTile
      file={file}
      kind={kind}
      checked={checked.has(file.key)}
      onCheckedChange={(value) => setFileChecked(file.key, value)}
      onRoleChange={(role) => changeRole(file, role)}
    />
  )
  const photos = group.files.filter((file) => file.role === 'photo').length
  const splitChecked = () => {
    actions.split(group, [...checked])
    setChecked(new Set())
  }

  if (group.files.length === 0) {
    return null
  }
  return (
    <InfoSection
      title={`Файлы · ${formatNumber(group.files.length)}`}
      aside={
        <Button
          variant="ghost"
          size="sm"
          pending={actions.downloading}
          onClick={() => actions.download(group)}
        >
          <DownloadIcon />
          Скачать исходник
        </Button>
      }
    >
      {photos > 1 && group.archive_entries === null ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-ink-3">Фото</span>
          <Button
            variant="link"
            size="inline"
            className="text-sm"
            onClick={() => reorder(orderedKeys(files, 'name'))}
          >
            По имени
          </Button>
          <Button
            variant="link"
            size="inline"
            className="text-sm"
            onClick={() => reorder(orderedKeys(files, 'shot'))}
          >
            По времени съёмки
          </Button>
        </div>
      ) : null}
      {checked.size > 0 ? (
        <div className="flex h-8 items-center gap-3 rounded-lg bg-primary-tint px-3 text-sm">
          <span className="text-primary-ink">Выбрано {formatNumber(checked.size)}</span>
          <Button variant="link" size="inline" className="text-sm" onClick={splitChecked}>
            Выделить в новую
          </Button>
          <Button
            variant="link"
            size="inline"
            className="ml-auto text-muted-foreground text-sm"
            onClick={() => setChecked(new Set())}
          >
            Снять
          </Button>
        </div>
      ) : null}
      {group.archive_entries !== null ? (
        <ArchiveContents
          files={files}
          pending={false}
          onSplit={(keys) => actions.split(group, keys)}
          renderFiles={(inFolder) => (
            <FileGrid
              items={inFolder}
              getKey={fileKey}
              renderItem={renderFile}
              cellWidth={TILE_WIDTH}
              rowHeight={TILE_HEIGHT}
              label="Файлы папки"
              scrollRef={scrollRef}
              className="justify-between"
            />
          )}
        />
      ) : (
        // Порядок — перетаскиванием (до 200 файлов) и с клавиатуры: `Space` — взять,
        // стрелки — нести, `Space` — положить; больше 200 — ряды окнами прокрутки.
        <FileGrid
          items={files}
          getKey={fileKey}
          renderItem={renderFile}
          cellWidth={TILE_WIDTH}
          rowHeight={TILE_HEIGHT}
          label="Файлы группы"
          onReorder={reorder}
          scrollRef={scrollRef}
          className="justify-between"
        />
      )}
    </InfoSection>
  )
}
