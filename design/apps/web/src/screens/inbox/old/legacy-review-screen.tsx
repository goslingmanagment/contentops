import { isApiError } from '@contentops/contracts'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { useLayoutEffect, useRef } from 'react'
import { useLegacyReview } from '@/data/inbox'
import { useHistoryScroll } from '@/lib/use-history-state'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { InboxForbidden } from '../shared/inbox-forbidden'
import { InboxHeader } from '../shared/inbox-header'
import { DisputeGroups } from './dispute-groups'
import { ImportLine } from './import-line'
import { LabelMapCard } from './label-map-card'
import { useLegacyActions } from './use-legacy-actions'

const SKELETON_ROWS = [0, 1, 2, 3] as const

/**
 * Приехало › Разбор старого `#/<модель>/inbox/old` (DESIGN §4.9): довести импорт до «всё
 * разобрано» и не утопить ежедневное «Приехало». Строка хода, разовая карточка меток и
 * спорное по видам; у спорного — готовое решение по норме одной кнопкой.
 */
export function LegacyReviewScreen() {
  const model = useCurrentModel()
  const review = useLegacyReview(model.code)
  const actions = useLegacyActions()
  const scroll = useHistoryScroll('legacy:scroll')
  const scrollRef = useRef<HTMLDivElement>(null)
  const data = review.data

  useLayoutEffect(() => {
    if (data && scroll.initialOffset && scrollRef.current) {
      scrollRef.current.scrollTop = scroll.initialOffset
    }
  }, [data, scroll.initialOffset])

  if (isApiError(review.error) && review.error.status === 403) {
    return <InboxForbidden />
  }
  const labelsWaiting = data?.labels.some((label) => label.target === null) ?? false
  const disputesLeft = data?.disputes.some((dispute) => !dispute.resolved) ?? false

  return (
    <FieldLayout>
      <InboxHeader active="old" />
      <RefreshStrip active={review.isFetching && data !== undefined} />
      <div
        ref={scrollRef}
        onScroll={(event) => scroll.onScrollOffsetChange(event.currentTarget.scrollTop)}
        className="-mx-7 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-7 pt-3 pb-8"
      >
        {review.isPending ? (
          <div aria-hidden className="flex flex-col gap-3">
            <Skeleton className="h-10 w-2/3 rounded-lg" />
            {SKELETON_ROWS.map((row) => (
              <ListRowSkeleton key={row} height={64} />
            ))}
          </div>
        ) : null}
        {review.isError ? (
          <ErrorLine
            layout="center"
            message="Не загрузилось"
            onRetry={() => void review.refetch()}
          />
        ) : null}
        {data ? (
          <>
            <ImportLine progress={data.progress} />
            {labelsWaiting ? (
              <LabelMapCard
                labels={data.labels}
                accounts={model.accounts}
                saving={actions.savingLabels}
                onSave={actions.saveLabels}
              />
            ) : null}
            {disputesLeft ? (
              <DisputeGroups disputes={data.disputes} labels={data.labels} />
            ) : (
              <EmptyState className="min-h-24">Спорного нет — всё разобрано</EmptyState>
            )}
          </>
        ) : null}
      </div>
    </FieldLayout>
  )
}
