import type { DraftHint, InboxGroup, Instant } from '@contentops/contracts'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { cn } from '@contentops/ui/lib/utils'
import { type RefObject, useImperativeHandle, useRef, useState } from 'react'
import { useCurrentModel } from '@/shell/model/model-context'
import { useUploadTarget } from '@/shell/upload/upload-context'
import { useSourceName } from '../shared/disk-line'
import { groupSource } from '../shared/group-source'
import { GroupStateLine } from '../shared/group-state-line'
import { groupStateView, metaLine } from '../shared/group-texts'
import type { IntakeActions } from '../shared/use-intake-actions'
import { DecisionBlock } from './decision-block'
import { type ActionBarHandle, DraftActionBar } from './draft-action-bar'
import { DraftFields } from './draft-fields'
import { DraftFiles } from './draft-files'
import { DraftHints } from './draft-hints'
import { TargetCard, targetNoteOf } from './target-card'
import { useDraftSave } from './use-draft-save'

export type SimilarHint = Extract<DraftHint, { kind: 'similar' }>

/** Команды панели извне: клавиши списка и меню группы по правому клику (§3.6, §3.12). */
export interface DraftPanelHandle extends ActionBarHandle {
  /** «Разделить…»: показать файлы, где отмечаются галочки для «Выделить в новую». */
  showFiles: () => void
}

export interface DraftPanelProps {
  group: InboxGroup
  /** Меню группы — то же, что по правому клику на плитке. */
  menuFor: (group: InboxGroup) => ItemMenuModel
  now: Instant
  channelName: (id: string) => string
  actions: IntakeActions
  handleRef: RefObject<DraftPanelHandle | null>
  onSkip: () => void
  /** Вернуть фокус в список групп (после всплывашки, открытой клавишей из него). */
  onReturnToList: () => void
  onCompare: (group: InboxGroup, hint: SimilarHint) => void
}

/**
 * Панель решения одной группы (DESIGN §4.8): сверху, вне прокрутки, — название, где лежит,
 * состояние и кнопки; ниже прокручиваются разбор, подсказки, поля и файлы.
 */
export function DraftPanel({
  group,
  menuFor,
  now,
  channelName,
  actions,
  handleRef,
  onSkip,
  onReturnToList,
  onCompare,
}: DraftPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<ActionBarHandle>(null)
  const saver = useDraftSave(group)
  const cloud = useSourceName(useCurrentModel().code)
  // «Отдельным объектом» / «Принять отдельно»: вместо цели — форма черновика (§4.8).
  const [separate, setSeparate] = useState(false)
  const target = separate ? null : targetNoteOf(group)
  useImperativeHandle(
    handleRef,
    () => ({
      primary: () => barRef.current?.primary(),
      second: (origin) => barRef.current?.second(origin),
      extend: (origin) => barRef.current?.extend(origin),
      reject: (origin) => barRef.current?.reject(origin),
      focus: () => barRef.current?.focus(),
      showFiles: () => filesRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    }),
    [],
  )
  // Загрузка заново после ▲ «Загрузка не прошла проверку» идёт в тот же объект (§3.7).
  useUploadTarget(
    group.state.kind === 'error' && group.target_item
      ? { kind: 'item', itemId: group.target_item, title: group.fields.title || group.title }
      : null,
  )
  const pending = actions.deciding
  // Монтаж уже стал объектом: решается только строка плана, полей черновика нет (§4.8).
  const source = groupSource(group)
  const montageOnly =
    group.state.kind === 'decision' && group.state.decision === 'substitute_montage'

  return (
    <>
      <div className="flex shrink-0 flex-col gap-3 border-border border-b px-5 pt-5 pb-4">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="line-clamp-2 text-lg">{group.title}</h2>
            <p className="truncate text-muted-foreground text-sm">{metaLine(group, now)}</p>
            <p
              className={cn('truncate text-ink-3', source.path ? 'font-mono text-xs' : 'text-sm')}
              title={source.text}
            >
              {source.text}
            </p>
          </div>
          <ItemMenuButton
            menu={menuFor(group)}
            label="Действия группы"
            size="icon-sm"
            className="-mr-1.5"
          />
        </div>
        <GroupStateLine view={groupStateView(group, channelName, true, cloud)} wrap="start" />
        <DraftActionBar
          group={group}
          actions={actions}
          onSkip={onSkip}
          onReturnToList={onReturnToList}
          separate={separate}
          onSeparateChange={setSeparate}
          handleRef={barRef}
        />
      </div>
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-8"
      >
        <DecisionBlock
          group={group}
          now={now}
          pending={pending}
          decide={(command) => actions.decide(group, command)}
        />
        {target ? <TargetCard group={group} note={target} /> : null}
        <DraftHints hints={group.hints} onCompare={(hint) => onCompare(group, hint)} />
        {montageOnly || target ? null : <DraftFields key={group.id} group={group} saver={saver} />}
        <div ref={filesRef}>
          <DraftFiles group={group} actions={actions} scrollRef={scrollRef} />
        </div>
      </div>
    </>
  )
}
