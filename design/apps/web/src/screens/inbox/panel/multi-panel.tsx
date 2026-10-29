import { formatNumber, type InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Thumb } from '@contentops/ui/components/thumb'
import { FileArchiveIcon } from 'lucide-react'
import { useState } from 'react'
import { batchModelOf, batchSummary } from '../shared/batch'
import { BatchButtons } from '../shared/batch-buttons'
import { groupKind } from '../shared/draft-cover'
import { GroupStateLine } from '../shared/group-state-line'
import { groupStateView } from '../shared/group-texts'
import type { IntakeActions } from '../shared/use-intake-actions'
import { RejectPopover } from './reject-popover'

interface MultiPanelProps {
  groups: readonly InboxGroup[]
  actions: IntakeActions
  channelName: (id: string) => string
}

/**
 * Несколько выбранных групп (DESIGN §3.4): «Выбрано 5 · …» и те же кнопки, что в полосе;
 * ниже — выбранные группы строками, чтобы видеть, что уйдёт в пакет.
 */
export function MultiPanel({ groups, actions, channelName }: MultiPanelProps) {
  const [rejecting, setRejecting] = useState(false)
  const rejectable = batchModelOf(groups).rejectable
  return (
    <>
      <div className="flex shrink-0 flex-col gap-3 border-border border-b px-5 pt-5 pb-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg">Выбрано {formatNumber(groups.length)}</h2>
          <p className="text-muted-foreground text-sm">{batchSummary(groups)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <BatchButtons groups={groups} actions={actions} surface="panel" />
          {rejectable.length > 0 ? (
            <RejectPopover
              open={rejecting}
              onOpenChange={setRejecting}
              onReject={(reason) =>
                actions.reject(
                  rejectable.map((group) => group.id),
                  reason,
                )
              }
              submitLabel={`Отклонить ${formatNumber(rejectable.length)}`}
              align="end"
            >
              <Button variant="outline">Отклонить…</Button>
            </RejectPopover>
          ) : null}
        </div>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-3 pb-8">
        {groups.map((group) => {
          const [first] = group.files
          return (
            <li key={group.id} className="flex h-13 items-center gap-3 rounded-lg px-2">
              {first ? (
                <Thumb
                  seed={first.thumb.key}
                  kind={groupKind(group)}
                  showCaptions={false}
                  className="w-7.5 shrink-0 rounded-md"
                />
              ) : (
                // Архив без оглавления: значок архива, как на плитке, а не пустая клетка.
                <span className="flex h-10 w-7.5 shrink-0 items-center justify-center rounded-md bg-muted text-ink-3">
                  <FileArchiveIcon aria-hidden className="size-4" strokeWidth={1.5} />
                </span>
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{group.title}</span>
                <GroupStateLine view={groupStateView(group, channelName)} />
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}
