import type {
  PublicationActionAnswer,
  PublicationApproveManyAnswer,
  PublicationPageSettingsCommand,
  PublicationResolveCommand,
} from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'

type PostVerb = 'cancel' | 'withdraw' | 'replace' | 'deletePost'

const DONE_WORDS: Record<PostVerb | 'approve' | 'resolve', string> = {
  approve: 'Пост утверждён: в расписание он встанет сам',
  cancel: 'Публикация отменена',
  withdraw: 'Пост убирается из расписания',
  replace: 'Замена создана черновиком: утвердите её',
  resolve: 'Ответ записан',
  deletePost: 'Пост удаляется со стены',
}

/**
 * Действия «Публикаций» (пакет C2): каждое делает Hub от имени вошедшего человека и сам решает, можно ли.
 * Отказ Hub — полоской его словами; после ответа лента и карточка перечитываются.
 */
export function usePublicationActions(onOpen?: (id: number) => void) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const invalidates = () => [
    queryKeys.publicationsAll(model),
    ['model', model, 'publication'] as const,
  ]
  const answered = (answer: PublicationActionAnswer, done: string) => {
    if (answer.outcome === 'refused') {
      toast.show({ message: answer.words ?? 'Не получилось' })
      return
    }
    toast.show({ message: done })
  }

  const approve = useIntentMutation<{ id: number; version: number }, PublicationActionAnswer>({
    failed: 'Не утвердилось',
    run: ({ id, version }, key) =>
      api.publications.approve({
        params: { model, publication: String(id) },
        body: { version },
        idempotencyKey: key,
      }),
    onSuccess: (answer) => answered(answer, DONE_WORDS.approve),
    invalidates,
  })

  const post = useIntentMutation<{ id: number; verb: PostVerb }, PublicationActionAnswer>({
    failed: 'Не получилось',
    run: ({ id, verb }, key) =>
      api.publications[verb]({
        params: { model, publication: String(id) },
        body: {},
        idempotencyKey: key,
      }),
    onSuccess: (answer, { verb }) => {
      answered(answer, DONE_WORDS[verb])
      if (verb === 'replace' && answer.publication_id !== null) onOpen?.(answer.publication_id)
    },
    invalidates,
  })

  const resolve = useIntentMutation<
    { id: number; answer: PublicationResolveCommand },
    PublicationActionAnswer
  >({
    failed: 'Ответ не записался',
    run: ({ id, answer }, key) =>
      api.publications.resolve({
        params: { model, publication: String(id) },
        body: answer,
        idempotencyKey: key,
      }),
    onSuccess: (answer) => answered(answer, DONE_WORDS.resolve),
    invalidates,
  })

  const page = useIntentMutation<
    { page: string; verb: 'refreshPage' | 'withdrawPage' },
    PublicationActionAnswer
  >({
    failed: 'Не получилось',
    run: ({ page: label, verb }, key) =>
      api.publications[verb]({ params: { model, page: label }, body: {}, idempotencyKey: key }),
    onSuccess: (answer, { verb }) =>
      answered(
        answer,
        verb === 'refreshPage'
          ? 'Расписание перечитается в течение пары минут'
          : 'Посты убираются из расписания',
      ),
    invalidates,
  })

  const settings = useIntentMutation<
    { page: string; body: PublicationPageSettingsCommand },
    PublicationActionAnswer
  >({
    failed: 'Настройки не сохранились',
    run: ({ page: label, body }, key) =>
      api.publications.pageSettings({ params: { model, page: label }, body, idempotencyKey: key }),
    onSuccess: (answer) => answered(answer, 'Настройки страницы сохранены'),
    invalidates,
  })

  const switchSet = useIntentMutation<
    { key: string; value: string | number | boolean; version: number | null },
    PublicationActionAnswer
  >({
    failed: 'Выключатель не сохранился',
    run: ({ key: name, value, version }, key) =>
      api.publications.setSwitches({
        params: { model },
        body: {
          patches: [
            { key: name, value, ...(version === null ? {} : { expected_version: version }) },
          ],
        },
        idempotencyKey: key,
      }),
    onSuccess: (answer) => answered(answer, 'Сохранено'),
    invalidates: () => [...invalidates(), ['model', model, 'publication-switches'] as const],
  })

  /** «Утвердить выбранные»: each draft's outcome goes to `onAnswered` (the feed lists the refusals in Hub's words). */
  const approveMany = useIntentMutation<
    {
      items: { id: number; version: number }[]
      onAnswered: (answer: PublicationApproveManyAnswer) => void
    },
    PublicationApproveManyAnswer
  >({
    failed: 'Не утвердилось',
    run: ({ items }, key) =>
      api.publications.approveMany({ params: { model }, body: { items }, idempotencyKey: key }),
    onSuccess: (answer, { onAnswered }) => {
      const approved = answer.results.filter((one) => one.outcome === 'approved').length
      const refused = answer.results.length - approved
      toast.show({
        message:
          refused === 0
            ? `Утверждено ${approved}: Hub поставит их сам`
            : `Утверждено ${approved}, не утверждено ${refused}`,
      })
      onAnswered(answer)
    },
    invalidates,
  })

  return { approve, approveMany, post, resolve, page, settings, switchSet }
}

export type PublicationActions = ReturnType<typeof usePublicationActions>
