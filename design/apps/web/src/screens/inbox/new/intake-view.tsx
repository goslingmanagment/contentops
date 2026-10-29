import { type InboxGroup, isApiError } from '@contentops/contracts'
import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import { PanelMessage } from '@contentops/ui/components/panel-frame'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { Viewer } from '@contentops/ui/components/viewer'
import { isTypingTarget } from '@contentops/ui/lib/platform'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useClock } from '@/data/api-session'
import { useInboxList } from '@/data/inbox'
import { usePromoChannels } from '@/data/promo'
import { useHistoryScroll } from '@/lib/use-history-state'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useRememberedView } from '@/shell/field/use-remembered-view'
import { useCurrentModel } from '@/shell/model/model-context'
import { DecisionPanel, DecisionPanelSkeleton } from '../panel/decision-panel'
import type { DraftPanelHandle } from '../panel/draft-panel'
import type { InboxView } from '../search'
import { isAcceptable } from '../shared/batch'
import { DiskLine } from '../shared/disk-line'
import { InboxForbidden } from '../shared/inbox-forbidden'
import { InboxHeader } from '../shared/inbox-header'
import { useGroupMenu } from '../shared/use-group-menu'
import { type DecisionOutcome, useIntakeActions } from '../shared/use-intake-actions'
import { IntakeCollection, optionId } from './intake-collection'
import {
  buildSections,
  firstActionable,
  flatten,
  nextNeedingPerson,
  pinSections,
  type SectionPins,
} from './intake-sections'
import { IntakeSelectionBar } from './intake-selection-bar'
import { IntakeSkeleton } from './intake-skeleton'
import { useIntakeKeys } from './use-intake-keys'
import { previewTitle, useIntakePreview } from './use-intake-preview'
import { useIntakeSelection } from './use-intake-selection'

interface IntakeViewProps {
  /** Вид из адреса `?view=list`. */
  viewParam: InboxView | undefined
  /** Вид пишется в адрес своего маршрута, без новой записи истории. */
  onViewParamChange: (view: InboxView) => void
  /** Группа из адреса `#/<модель>/inbox/g/<id>`: её показывает панель при входе. */
  initialGroupId?: string
}

/**
 * Приехало › Новое (DESIGN §4.8): решить судьбу нового за 1–2 клика на пачку. Слева
 * группы разделами «Нужно решение», «Готово», «Готовится»; справа панель решения, открыта
 * всегда. После решения группа уходит, фокус — на следующую.
 */
export function IntakeView({ viewParam, onViewParamChange, initialGroupId }: IntakeViewProps) {
  const model = useCurrentModel()
  const navigate = useNavigate()
  const now = useClock().now()
  const list = useInboxList(model.code, 'active')
  const channels = usePromoChannels(model.code).data
  const { view: rememberedView, remember } = useRememberedView('inbox', viewParam)
  const view: InboxView = rememberedView === 'list' ? 'list' : 'large'

  // Решённая группа стоит на месте до ухода с экрана (§1.7): разделы помнят первый вид.
  const pins = useRef<SectionPins>(new Map())
  const sections = useMemo(() => {
    const items = list.data?.items ?? []
    return buildSections(items, pinSections(pins.current, items))
  }, [list.data])
  const groups = useMemo(() => flatten(sections), [sections])
  const fallbackKey =
    (initialGroupId && groups.some((group) => group.id === initialGroupId)
      ? initialGroupId
      : firstActionable(sections)?.id) ?? null
  const panelRef = useRef<DraftPanelHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scroll = useHistoryScroll('inbox:scroll')
  const preview = useIntakePreview()
  // Группы из адреса нет среди нового: панель говорит об этом одной строкой и ничего не
  // выбирает сама. Решается один раз, по первым данным: принятая потом группа уходит
  // из списка обычным путём.
  const hasData = list.data !== undefined
  const [groupGone, setGroupGone] = useState<boolean | null>(null)
  if (groupGone === null && hasData) {
    setGroupGone(
      initialGroupId !== undefined && !groups.some((group) => group.id === initialGroupId),
    )
  }
  const selection = useIntakeSelection({ groups, fallbackKey, autoSelect: groupGone !== true })
  // После решения фокус в списке (§7.8): цифры и стрелки работают дальше. Группу, с
  // которой человеку делать нечего («Повторить», «Ждать»), сменяет следующая, где он нужен.
  const { focusAt } = selection
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const onDecided = useCallback(
    (group: InboxGroup, outcome: DecisionOutcome) => {
      if (outcome === 'skip') {
        const next = nextNeedingPerson(groupsRef.current, group.id)
        const index = next ? groupsRef.current.indexOf(next) : -1
        if (index >= 0) {
          focusAt(index, false)
        }
      }
      if (!isTypingTarget(document.activeElement)) {
        listRef.current?.focus({ preventScroll: true })
      }
    },
    [focusAt],
  )
  const actions = useIntakeActions({ onShow: selection.selectKeys, onDecided })
  const menuFor = useGroupMenu(groups, actions, panelRef)

  const channelName = useCallback(
    (id: string) => channels?.find((channel) => channel.id === id)?.name ?? id,
    [channels],
  )
  const readySection = sections.find((section) => section.key === 'ready')
  const acceptableReady = useMemo(
    () => (readySection?.groups ?? []).filter(isAcceptable),
    [readySection],
  )

  const { openGroup } = preview
  const current = selection.current
  const openPreview = useCallback(() => {
    if (current) {
      openGroup(current)
    }
  }, [current, openGroup])
  const onKeyDown = useIntakeKeys({
    listRef,
    sections,
    view,
    selection,
    panelRef,
    onPreview: openPreview,
  })

  // Возврат восстанавливает прокрутку, как только группы нарисованы (§3.13); вход по адресу
  // группы показывает её плитку.
  const cameWithGroup = initialGroupId !== undefined && selection.focusKey === initialGroupId
  useLayoutEffect(() => {
    const element = listRef.current
    if (!hasData || !element) {
      return
    }
    if (scroll.initialOffset) {
      element.scrollTop = scroll.initialOffset
    } else if (cameWithGroup) {
      document.getElementById(optionId(element.id, selection.focusIndex))?.scrollIntoView({
        block: 'center',
      })
    }
    // Только при первом показе данных: дальше прокруткой владеет человек.
  }, [hasData, cameWithGroup])

  // Фокус с клавиатуры доводится прокруткой до плитки.
  useLayoutEffect(() => {
    const element = listRef.current
    if (element && element === document.activeElement) {
      document.getElementById(optionId(element.id, selection.focusIndex))?.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [selection.focusIndex])

  const changeView = (next: ObjectTileView) => {
    const param = next === 'row' ? 'list' : 'large'
    remember(param)
    onViewParamChange(param)
  }
  const skip = () => {
    if (selection.current) {
      onDecided(selection.current, 'skip')
    }
  }
  const forbidden = isApiError(list.error) && list.error.status === 403
  const multi = selection.selectedGroups.length > 1

  if (forbidden) {
    return <InboxForbidden />
  }

  return (
    <FieldLayout
      aside={
        list.isPending ? (
          <DecisionPanelSkeleton />
        ) : groupGone && selection.current === null && !multi ? (
          <PanelMessage
            label="Группа"
            onClose={() => void navigate({ to: '/$model/inbox', params: { model: model.code } })}
          >
            Такой группы у {model.name_genitive} нет
          </PanelMessage>
        ) : groups.length > 0 ? (
          <DecisionPanel
            current={selection.current}
            selected={selection.selectedGroups}
            menuFor={menuFor}
            now={now}
            channelName={channelName}
            actions={actions}
            handleRef={panelRef}
            onSkip={skip}
            onReturnToList={() => listRef.current?.focus()}
            onCompare={preview.openCompare}
          />
        ) : null
      }
    >
      <InboxHeader
        active="new"
        aside={<DiskLine model={model.code} checkedAt={list.data?.disk_checked_at ?? null} />}
        view={{ value: view === 'list' ? 'row' : 'large', onChange: changeView }}
        selectionBar={
          multi ? (
            <IntakeSelectionBar
              groups={selection.selectedGroups}
              actions={actions}
              onClear={selection.collapse}
            />
          ) : undefined
        }
      />
      <RefreshStrip active={list.isFetching && hasData} />
      <QueryErrorLine query={list} hasData={hasData} />
      {list.isPending ? <IntakeSkeleton view={view} /> : null}
      {/* Когда проверен Я.Диск, уже написано в шапке справа — здесь только итог. */}
      {hasData && groups.length === 0 ? <EmptyState>Всё разобрано.</EmptyState> : null}
      {groups.length > 0 ? (
        <IntakeCollection
          sections={sections}
          view={view}
          selectedKeys={selection.selectedKeys}
          focusIndex={selection.focusIndex}
          now={now}
          channelName={channelName}
          readyBatch={{
            groups: acceptableReady,
            pending: actions.acceptingMany,
            onAccept: () => actions.acceptMany(acceptableReady),
          }}
          menuFor={menuFor}
          onItemClick={selection.click}
          onItemDoubleClick={openPreview}
          onToggle={selection.toggle}
          onSelectSection={(section) =>
            selection.selectKeys(section.groups.map((group) => group.id))
          }
          onKeyDown={onKeyDown}
          listRef={listRef}
          onScroll={scroll.onScrollOffsetChange}
        />
      ) : null}
      {preview.preview ? (
        <Viewer
          open
          onOpenChange={(open) => {
            if (!open) {
              preview.close()
              // Просмотр открыт клавишей из списка — туда и возвращается фокус (§7.8).
              requestAnimationFrame(() => listRef.current?.focus())
            }
          }}
          title={previewTitle(preview.preview)}
          files={preview.preview.files}
          index={preview.preview.index}
          onIndexChange={preview.setIndex}
          compare={preview.preview.compare}
        />
      ) : null}
    </FieldLayout>
  )
}
