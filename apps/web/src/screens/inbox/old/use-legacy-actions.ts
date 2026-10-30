import {
  type Dispute,
  formatNumber,
  type LabelTarget,
  type LegacyReview,
} from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { type DisputeAnswer, useInboxCommands } from '@/data/inbox'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'

/** Ключ решения «Так и сделать»: готовое предложение по норме. */
export const PROPOSAL_OPTION = 'proposal'
/** «Неясно — оставить в разборе»: случай остаётся спорным, решение пишется в журнал. */
export const UNCLEAR_OPTION = 'unclear'
/** «Номер занят» с выбором у каждой папки. */
export const FOLDERS_OPTION = 'folders'
/** «Метка из имени», привязанная по сохранённой карточке меток. */
export const BY_LABELS_OPTION = 'by_labels'

interface ResolveVariables {
  dispute: string
  option: string
  /** Что написать в полоске: «Разобрано · PPV-032 у трёх папок». */
  title: string
  /** «Номер занят»: имя папки → вариант. */
  folders?: Readonly<Record<string, string>>
  /** Причина или тип и номер у вариантов со словами. */
  extra?: DisputeAnswer
}

/** Сколько «Меток из имени» решено по карточке: для полоски после «Сохранить». */
function settledByLabels(review: LegacyReview | undefined): number {
  return (review?.disputes ?? []).filter((dispute) => dispute.resolved?.option === BY_LABELS_OPTION)
    .length
}

/**
 * Действия «Разбор старого» (DESIGN §4.9): решение спорного и метки старых имён. Ответ —
 * весь разбор заново, он встаёт в кэш сразу; число на вкладке пересчитывается.
 */
export function useLegacyActions() {
  const model = useCurrentModel().code
  const commands = useInboxCommands(model)
  const queryClient = useQueryClient()
  const toast = useActionToast()
  const put = (review: LegacyReview) => queryClient.setQueryData(queryKeys.legacy(model), review)

  const resolve = useIntentMutation<ResolveVariables, LegacyReview>({
    failed: 'Не сохранилось',
    run: ({ dispute, option, folders, extra }, key) =>
      commands.resolveDispute(dispute, option, key, folders, extra),
    invalidates: () => [queryKeys.inbox(model, 'active')],
    onSuccess: (review, { dispute, option, title }) => {
      put(review)
      const left = !review.disputes.find((item) => item.id === dispute)?.resolved
      toast.show({
        message:
          option === UNCLEAR_OPTION || left
            ? `Оставлено в разборе · ${title}`
            : `Разобрано · ${title}`,
      })
    },
  })

  // «Привязать все N по карточке»: у каждого случая свой производный ключ повтора.
  const bindByLabels = useIntentMutation<readonly Dispute[], LegacyReview[]>({
    failed: 'Не привязалось',
    run: (disputes, key) =>
      Promise.all(
        disputes.map((dispute) =>
          commands.resolveDispute(dispute.id, BY_LABELS_OPTION, `${key}:${dispute.id}`),
        ),
      ),
    invalidates: () => [queryKeys.legacy(model), queryKeys.inbox(model, 'active')],
    onSuccess: (_, disputes) =>
      toast.show({ message: `Привязано по карточке меток: ${formatNumber(disputes.length)}` }),
  })

  const saveLabels = useIntentMutation<
    readonly { label: string; target: LabelTarget | null }[],
    LegacyReview
  >({
    failed: 'Метки не сохранились',
    run: (labels, key) => commands.saveLabels(labels, key),
    invalidates: () => [queryKeys.inbox(model, 'active')],
    onSuccess: (review) => {
      const before = settledByLabels(queryClient.getQueryData(queryKeys.legacy(model)))
      const settled = settledByLabels(review) - before
      put(review)
      toast.show({
        message:
          settled > 0
            ? `Метки сохранены · привязано старых имён: ${formatNumber(settled)}`
            : 'Метки сохранены',
      })
    },
  })

  return {
    resolve: (
      dispute: string,
      option: string,
      title: string,
      folders?: Readonly<Record<string, string>>,
      extra?: DisputeAnswer,
    ) => resolve.start({ dispute, option, title, folders, extra }),
    resolving: resolve.isPending || bindByLabels.isPending,
    bindByLabels: (disputes: readonly Dispute[]) => bindByLabels.start(disputes),
    saveLabels: (labels: readonly { label: string; target: LabelTarget | null }[]) =>
      saveLabels.start(labels),
    savingLabels: saveLabels.isPending,
  }
}
