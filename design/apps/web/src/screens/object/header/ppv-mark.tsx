import { formatPercent } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { StatusWord } from '@contentops/ui/components/status-word'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useHref } from '@/app/use-href'
import { itemQueryKeys } from '@/data/object'
import { useOperation } from '@/data/operations'
import { useObjectPage } from '../object-context'

/**
 * Кастом в шапке (DESIGN §4.5): плашка «готов для PPV», когда заказ сдан без открытых правок
 * и PPV ещё не сделан; до этого — слово заказа («◆ правка»); пока свой монтаж для PPV
 * загружается и проверяется — «монтаж для PPV проверяется · 40 %»; потом — ссылка «PPV-076
 * сделан из него».
 */
export function PpvMark() {
  const { detail, model } = useObjectPage()
  const href = useHref()
  const madeAs = detail.entry.ppv_made_as
  if (detail.ready_for_ppv) {
    return (
      <Badge variant="tint" className="h-6 px-2 text-sm">
        готов для PPV
      </Badge>
    )
  }
  if (detail.entry.type !== 'custom') {
    return null
  }
  if (detail.ppv_montage) {
    return <MontageChecking operationId={detail.ppv_montage.operation_id} />
  }
  // Заказ ещё не сдан или ждёт правку: слово заказа объясняет, почему главная — «Открыть заказ».
  if (!madeAs) {
    const status = detail.order?.status
    return status ? (
      <StatusWord sign={status.sign ?? undefined} className="shrink-0">
        {status.word}
      </StatusWord>
    ) : null
  }
  return (
    <UiLink
      href={href({ to: '/$model/i/$id', params: { model: model.code, id: madeAs } })}
      className="shrink-0 whitespace-nowrap text-primary-ink text-sm hover:underline"
    >
      {madeAs} сделан из него
    </UiLink>
  )
}

/** Ход своего монтажа; когда проверка закончилась, кастом перечитывается — придёт номер PPV. */
function MontageChecking({ operationId }: { operationId: string }) {
  const { detail, model } = useObjectPage()
  const queryClient = useQueryClient()
  const operation = useOperation(model.code, operationId).data
  const ended = operation !== undefined && operation.state !== 'running'
  useEffect(() => {
    if (!ended) {
      return
    }
    for (const queryKey of itemQueryKeys(model.code, detail.entry.id)) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }, [detail.entry.id, ended, model.code, queryClient])
  return (
    <StatusWord
      className="shrink-0"
      detail={operation ? formatPercent(operation.progress) : undefined}
    >
      монтаж для PPV проверяется
    </StatusWord>
  )
}
