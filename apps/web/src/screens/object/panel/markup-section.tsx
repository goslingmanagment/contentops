import {
  formatDate,
  formatNumber,
  type ItemDetail,
  type LocalDate,
  type MarkupFieldKey,
  mainVideo,
  mskDate,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { StatusWord } from '@contentops/ui/components/status-word'
import { useActionToast } from '@/actions/action-toast-context'
import { useApi, useToday } from '@/data/api-session'
import { useItemCommand } from '../actions/use-item-command'
import { useObjectPage } from '../object-context'
import { DescriptionField } from './markup/description-field'
import { PlatformTexts } from './markup/platform-texts'
import { TagsField } from './markup/tags-field'
import { TimelineField } from './markup/timeline-field'
import { TitleField } from './markup/title-field'

const DRAFT_STATUSES = new Set([
  'draft_ai',
  'draft_import',
  'confirmed_previous_version',
  'ai_failed',
])

function draftsOf(detail: ItemDetail) {
  return detail.markup.filter((field) => DRAFT_STATUSES.has(field.status))
}

/** Итог справа, как у поля (§5.4): «подтверждено · Диана 12.08» или «черновик: 2 поля». */
function summaryOf(detail: ItemDetail, today: LocalDate): { done: boolean; text: string } {
  const drafts = draftsOf(detail)
  if (drafts.length > 0) {
    const count = drafts.length
    return {
      done: false,
      text: `черновик: ${formatNumber(count)} ${plural(count, ['поле', 'поля', 'полей'])}`,
    }
  }
  const confirmed = detail.markup
    .filter((field) => field.status === 'confirmed' && field.confirmed_at)
    .sort((left, right) => (right.confirmed_at ?? '').localeCompare(left.confirmed_at ?? ''))[0]
  if (!confirmed?.confirmed_at) {
    return { done: false, text: 'не заполнена' }
  }
  return {
    done: true,
    text: [
      'подтверждено',
      [confirmed.confirmed_by, formatDate(mskDate(confirmed.confirmed_at), today)]
        .filter(Boolean)
        .join(' '),
    ].join(' · '),
  }
}

/**
 * Разметка (DESIGN §4.4, §5.4): итог справа и «Подтвердить всю разметку» (контурная),
 * пока есть черновики. Подтверждаются ровно те версии полей, что на экране; пришедшее
 * после нажатия остаётся черновиком.
 */
export function MarkupSection() {
  const today = useToday()
  const { detail, model, canAct } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const drafts = draftsOf(detail)
  const summary = summaryOf(detail, today)
  const confirm = useItemCommand<{ key: MarkupFieldKey; version: number }[]>({
    failed: 'Разметка не подтвердилась',
    run: (fields, idempotencyKey) =>
      api.objects.confirmMarkup({
        params: { model: model.code, id: detail.entry.id },
        body: { fields },
        idempotencyKey,
      }),
    onSaved: () => toast.show({ message: 'Разметка подтверждена' }),
  })

  return (
    <InfoSection
      title="Разметка"
      aside={<StatusWord sign={summary.done ? 'done' : undefined}>{summary.text}</StatusWord>}
    >
      {canAct && drafts.length > 0 ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          pending={confirm.isPending}
          onClick={() =>
            confirm.start(drafts.map((field) => ({ key: field.field.key, version: field.version })))
          }
        >
          Подтвердить всю разметку
        </Button>
      ) : null}
      <div className="flex flex-col gap-4">
        <TitleField />
        <TitleField fieldKey="title_en" label="По-английски" hint="2–5 слов для имени файла" />
        <TagsField />
        <DescriptionField />
        {/* Хронология — у ролика с мастером (монтажом): у лайфа, секстинга и сырья
            длительность — сумма клипов, дорожка по ней ничего не значит. */}
        {mainVideo(detail.files) ? <TimelineField /> : null}
        {detail.entry.type === 'ppv' ? <PlatformTexts /> : null}
      </div>
    </InfoSection>
  )
}
