import {
  formatClock,
  formatDate,
  formatNumber,
  type IntegrationView,
  type ItemPagePlacement,
  isPlacedLevel,
  type PlacementLevel,
  SURFACE_LABEL,
  type SurfacePlacement,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { useNavigate } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, DownloadIcon, XIcon } from 'lucide-react'
import { useActionToast } from '@/actions/action-toast-context'
import { useToday } from '@/data/api-session'
import { useIntegrations } from '@/data/integrations'
import { StatusLine } from '@/objects/status-line'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { useObjectPage } from '../object-context'
import { uploadNowSurface, usePageUpload } from './use-upload-now'

/** Hub этой страницы, если он не работает: строка интеграции и «на 13:52» у слов. */
function useHubTrouble(account: string): IntegrationView | undefined {
  const { model } = useObjectPage()
  return useIntegrations().data?.find(
    (integration) =>
      integration.kind === 'hub' &&
      integration.model === model.code &&
      integration.account === account &&
      integration.state !== 'working',
  )
}

/**
 * «Где залито · Fansly 3» в панели (DESIGN §4.4): строка на поверхность со словом и
 * датой, три факта предложениями, альбом vault, подпись с платформы и просмотры (Fansly;
 * нет их — «нет данных»), серые заметки. Одна кнопка по случаю: «Сверить», «Залить сейчас»
 * или «В план»; пока строка плана этой страницы не отмечена — «Скачать» и «Отметить залитым».
 */
export function PageDetail({ page }: { page: ItemPagePlacement }) {
  const { model, openPage } = useObjectPage()
  const hub = useHubTrouble(page.account)
  const account = model.accounts.find((candidate) => candidate.code === page.account)
  // «на 13:52» — только когда Hub недоступен: прежние данные подписаны временем источника.
  const asOf = hub?.state === 'down' && hub.since ? formatClock(hub.since) : null

  return (
    <InfoSection
      title={`Где залито · ${account?.label ?? page.account}`}
      aside={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Свернуть"
          onClick={() => openPage(undefined)}
        >
          <XIcon />
        </Button>
      }
    >
      {hub ? <IntegrationPhrase line={hub.line} wrap withOwnerAction /> : null}
      {page.surfaces.length === 0 ? (
        <p className="text-muted-foreground">Плана, отметок и постов Hub нет</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {page.surfaces.map((surface) => (
            <SurfaceRow
              key={`${surface.surface}-${surface.plan_row_id ?? ''}`}
              surface={surface}
              fansly={account?.platform === 'fansly'}
              asOf={asOf}
            />
          ))}
        </ul>
      )}
      <PageAction page={page} />
    </InfoSection>
  )
}

interface SurfaceRowProps {
  surface: SurfacePlacement
  /** Просмотры по файлу Hub собирает только у Fansly. */
  fansly: boolean
  asOf: string | null
}

function SurfaceRow({ surface, fansly, asOf }: SurfaceRowProps) {
  const today = useToday()
  const { verdict } = surface
  const facts = [verdict.facts.plan, verdict.facts.mark, verdict.facts.hub].filter(
    (fact): fact is string => fact !== null,
  )
  const date = verdict.date ? ` ${formatDate(verdict.date, today)}` : ''
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        <span className="w-18 shrink-0 text-muted-foreground">
          {SURFACE_LABEL[surface.surface]}
        </span>
        <StatusLine
          sign={verdict.sign ?? undefined}
          detail={
            verdict.detail || asOf
              ? [verdict.detail, asOf ? `на ${asOf}` : null].filter(Boolean).join(' · ')
              : undefined
          }
          className="pt-px"
        >
          {`${verdict.word}${date}`}
        </StatusLine>
      </div>
      <div className="flex flex-col gap-0.5 pl-20 text-sm">
        {facts.length > 0 ? <p>{facts.join(' · ')}</p> : <p>{verdict.reason}</p>}
        {surface.album ? <AlbumLine name={surface.album} /> : null}
        {surface.caption ? (
          <p className="line-clamp-2 text-muted-foreground">«{surface.caption}»</p>
        ) : null}
        {surface.views !== null && surface.stats_on ? (
          <p className="text-muted-foreground tabular-nums">
            {formatNumber(surface.views)} просмотров на {formatDate(surface.stats_on, today)}
          </p>
        ) : fansly && isPlacedLevel(verdict.level) ? (
          <p className="text-muted-foreground">Просмотры: нет данных</p>
        ) : null}
        {verdict.notes.map((note) => (
          <p key={note} className="text-ink-3">
            {note}
          </p>
        ))}
      </div>
    </li>
  )
}

/** Строка плана этой страницы ждёт заливки: отметки ещё нет. */
const OPEN_ROW_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>(['planned', 'missed'])

function openRowOf(page: ItemPagePlacement): SurfacePlacement | undefined {
  return page.surfaces.find(
    (surface) => surface.plan_row_id !== null && OPEN_ROW_LEVELS.has(surface.verdict.level),
  )
}

function PageAction({ page }: { page: ItemPagePlacement }) {
  const { detail, model, canAct } = useObjectPage()
  const navigate = useNavigate()
  const { openPlanDialog } = usePlanDialog()
  const upload = usePageUpload()
  const account = model.accounts.find((candidate) => candidate.code === page.account)
  if (!canAct || !account) {
    return null
  }
  const openRow = openRowOf(page)
  const album =
    uploadNowSurface(detail.entry.type) === 'vault'
      ? `${detail.entry.id} ${detail.entry.title}`
      : null

  // Строка стоит, отметки нет: скачать копию с кодом страницы и отметить залитым на месте.
  if (openRow?.plan_row_id) {
    const target = { account, rowId: openRow.plan_row_id }
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          pending={upload.downloading}
          onClick={() => upload.download(target)}
        >
          <DownloadIcon />
          Скачать
        </Button>
        <Button variant="outline" pending={upload.marking} onClick={() => upload.mark(target)}>
          <CheckIcon />
          Отметить залитым
        </Button>
      </div>
    )
  }
  if (!page.action) {
    return null
  }
  const run: Record<NonNullable<ItemPagePlacement['action']>, () => void> = {
    Сверить: () => void navigate({ to: '/$model/plan/check', params: { model: model.code } }),
    'Залить сейчас': () => upload.uploadNow(account),
    'В план': () => openPlanDialog([detail.entry.id]),
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="self-start"
        pending={page.action === 'Залить сейчас' && upload.uploadingNow}
        onClick={run[page.action]}
      >
        {page.action}
      </Button>
      {page.action === 'Залить сейчас' && album ? <AlbumLine name={album} /> : null}
    </div>
  )
}

/**
 * Имя альбома vault и «Копировать»: заливают в альбом с этим именем. Имя переносится —
 * по нему ищут альбом на странице.
 */
function AlbumLine({ name }: { name: string }) {
  const { canAct } = useObjectPage()
  const toast = useActionToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name)
      toast.show({ message: 'Имя альбома скопировано' })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }
  return (
    <p className="flex min-w-0 items-start gap-1 text-muted-foreground text-sm">
      <span className="min-w-0 py-0.5">Альбом: «{name}»</span>
      {canAct ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Копировать имя альбома"
          className="shrink-0"
          onClick={() => void copy()}
        >
          <CopyIcon />
        </Button>
      ) : null}
    </p>
  )
}
