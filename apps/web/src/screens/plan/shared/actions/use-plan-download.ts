import type { AccountCode, DownloadAnswer, IsoWeek, LocalDate } from '@contentops/contracts'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { usePlanCommands } from '@/data/plan'
import { useCurrentModel } from '@/shell/model/model-context'

export type PlanDownloadScope =
  | { scope: 'day'; date: LocalDate }
  | { scope: 'release'; release: string }
  | { scope: 'week'; week: IsoWeek }

interface DownloadRequest {
  target: PlanDownloadScope
  /** Одна страница или все. */
  account: AccountCode | null
  /** «Мои» в дне: архив — из тех же строк, что и объём у кнопки. */
  mine: boolean
  stripMetadata: boolean
}

const TRAY_LABEL: Record<PlanDownloadScope['scope'], string> = {
  day: 'Архив дня собирается',
  release: 'Архив выпуска собирается',
  week: 'Архив недели собирается',
}

/**
 * «Скачать всё за день ▾», «Скачать выпуск ▾», «Скачать неделю ▾» (DESIGN §2.5): архив
 * собирается долгой операцией (202), ход — в лотке внизу справа, можно уйти с экрана;
 * готовый архив уходит браузеру сам.
 */
export function usePlanDownload() {
  const model = useCurrentModel().code
  const commands = usePlanCommands(model)
  const deliver = useDeliverDownload()

  const download = useIntentMutation<DownloadRequest, DownloadAnswer>({
    failed: 'Архив не собрался',
    run: ({ target, account, mine, stripMetadata }, key) =>
      commands.download({
        key,
        command: {
          scope: target.scope,
          date: target.scope === 'day' ? target.date : null,
          week: target.scope === 'week' ? target.week : null,
          release_id: target.scope === 'release' ? target.release : null,
          account,
          mine,
          strip_metadata: stripMetadata,
        },
      }),
    onSuccess: (answer, { target }) =>
      deliver(model, [answer], { building: TRAY_LABEL[target.scope] }),
  })

  return {
    download: (
      target: PlanDownloadScope,
      account: AccountCode | null,
      stripMetadata: boolean,
      mine = false,
    ) => download.start({ target, account, mine, stripMetadata }),
    pending: download.isPending,
  }
}
