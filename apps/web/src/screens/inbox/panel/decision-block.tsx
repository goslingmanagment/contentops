import {
  type DecideCommand,
  type DecisionKind,
  formatWhen,
  type InboxGroup,
  type Instant,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import type { ComponentType } from 'react'
import { groupKind } from '../shared/draft-cover'
import { groupOrigin } from '../shared/group-source'
import { findHint } from '../shared/group-texts'
import { VIDEO_DESTINATIONS } from '../shared/video-destinations'
import { archiveFoldersOf } from './archive-contents'
import { FileThumb } from './file-thumb'
import { OrderCandidates } from './order-candidates'
import { TypeButtons } from './type-buttons'

export interface DecisionProps {
  group: InboxGroup
  now: Instant
  pending: boolean
  decide: (command: DecideCommand) => void
}

/**
 * Разбор ◆ в той же панели (DESIGN §4.8): список слева не перестраивается. Каждый вид
 * решения — свой небольшой блок; «Подставить монтаж» решается кнопками сверху.
 */
const DECISIONS: Record<DecisionKind, ComponentType<DecisionProps>> = {
  which_order: WhichOrder,
  what_is_it: WhatIsIt,
  video_in_set: VideoInSet,
  cross_model: CrossModel,
  number_taken: NumberTaken,
  substitute_montage: RowChange,
  split_archive: SplitArchive,
}

export function DecisionBlock(props: DecisionProps) {
  const state = props.group.state
  if (state.kind !== 'decision') {
    return null
  }
  const Decision = DECISIONS[state.decision]
  return <Decision {...props} />
}

function WhichOrder({ group, pending, decide }: DecisionProps) {
  return (
    <InfoSection title="Какой заказ?">
      <OrderCandidates
        group={group}
        pending={pending}
        onChoose={(orderId) => decide({ decision: 'which_order', order_id: orderId })}
      />
    </InfoSection>
  )
}

function WhatIsIt({ group, now, pending, decide }: DecisionProps) {
  const [file] = group.files
  const facts = [
    groupOrigin(group),
    file ? `Имя: ${file.file_name}` : null,
    file?.shot_at ? `Снято: ${formatWhen(file.shot_at, now)}` : null,
  ].filter((fact) => fact !== null)
  return (
    <InfoSection title="Что это?">
      <ul className="flex flex-col gap-0.5 text-sm">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <TypeButtons
        label="Что это?"
        value={null}
        disabled={pending}
        onChange={(type) => decide({ decision: 'what_is_it', type })}
      />
    </InfoSection>
  )
}

function VideoInSet({ group, pending, decide }: DecisionProps) {
  const videos = group.files.filter((file) => file.media === 'video')
  return (
    <InfoSection title="Видео среди фото — куда?">
      <div className="flex gap-2">
        {videos.map((file) => (
          <FileThumb key={file.key} file={file} kind={groupKind(group)} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {VIDEO_DESTINATIONS.map((destination) => (
          <Button
            key={destination.value}
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => decide({ decision: 'video_in_set', destination: destination.value })}
          >
            {destination.label}
          </Button>
        ))}
      </div>
    </InfoSection>
  )
}

function CrossModel({ group, pending, decide }: DecisionProps) {
  const other = findHint(group.hints, 'other_model')
  return (
    <InfoSection title="Такой файл есть у другой модели">
      {other ? <p className="text-sm">{other.text}</p> : null}
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => decide({ decision: 'cross_model', keep: true })}
        className="self-start"
      >
        Проверить
      </Button>
    </InfoSection>
  )
}

function NumberTaken({ pending, decide }: DecisionProps) {
  return (
    <InfoSection title="Номер занят">
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => decide({ decision: 'number_taken', keep: true })}
        >
          Оставить
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => decide({ decision: 'number_taken', keep: false })}
        >
          Новый номер
        </Button>
      </div>
    </InfoSection>
  )
}

/**
 * ◆ «Разделить архив?» (§4.8): в архиве несколько съёмок — он принимается по папкам
 * оглавления, каждая своей группой. Оглавление с файлами — ниже, в «Файлах».
 */
function SplitArchive({ group, pending, decide }: DecisionProps) {
  const folders = archiveFoldersOf(group.files)
  return (
    <InfoSection title="Разделить архив?">
      <p className="text-sm">
        {`Внутри ${folders.length} ${plural(folders.length, ['папка', 'папки', 'папок'])}: `}
        {folders.map((folder) => folder.name).join(', ')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => decide({ decision: 'split_archive', split: true })}
        >
          Разделить по папкам
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => decide({ decision: 'split_archive', split: false })}
        >
          Оставить одной группой
        </Button>
      </div>
    </InfoSection>
  )
}

function RowChange({ group }: DecisionProps) {
  const change = findHint(group.hints, 'row_change')
  if (!change) {
    return null
  }
  return (
    <InfoSection title="Строка плана изменилась">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-3">было</dt>
        <dd className="text-muted-foreground line-through decoration-line-strong">{change.was}</dd>
        <dt className="text-ink-3">стало</dt>
        <dd>{change.now}</dd>
      </dl>
    </InfoSection>
  )
}
