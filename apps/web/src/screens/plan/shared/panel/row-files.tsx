import {
  formatDate,
  formatWeekdayShort,
  type LocalDate,
  mskDate,
  mskTime,
  type PlanRow,
  pastVerb,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { CopyIcon, DownloadIcon } from 'lucide-react'
import { useActionToast } from '@/actions/action-toast-context'
import { useToday } from '@/data/api-session'
import { useSession } from '@/data/session'
import { useRowActions } from '../actions/use-row-actions'
import { copyCaption } from '../plan-text'

interface RowFilesProps {
  row: PlanRow
  accountLabel: string
}

function receiptText(
  row: PlanRow,
  me: { name: string; gender: 'f' | 'm' } | null,
  today: LocalDate,
): string | null {
  const receipt = row.downloaded
  if (!receipt) {
    return null
  }
  const date = mskDate(receipt.at)
  const when = `${formatWeekdayShort(date)} ${formatDate(date, today)}, ${mskTime(receipt.at)}`
  const stripped = receipt.meta_stripped ? ' · метаданные стёрты' : ''
  if (me && receipt.by === me.name) {
    return `Уже ${pastVerb('скачивал', me.gender)}: ${when}${stripped}`
  }
  return `Скачано: ${when} · ${receipt.by}${stripped}`
}

/**
 * «Скачать для Fansly 2» (DESIGN §4.11): файлы этой страницы с именем в подсказке,
 * квитанция «Уже скачивала», имя альбома vault с «Копировать».
 */
export function RowFiles({ row, accountLabel }: RowFilesProps) {
  const today = useToday()
  const actions = useRowActions()
  const toast = useActionToast()
  const person = useSession().data?.person ?? null
  const manifest = row.manifest
  if (!manifest) {
    return null
  }
  const copy = copyCaption(row)
  const receipt = receiptText(row, person, today)
  const album = row.surface === 'vault' ? row.album : null

  const copyAlbum = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.show({ message: `Скопировано · ${text}` })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }

  return (
    <InfoSection title={`Скачать для ${accountLabel}`}>
      <ul className="flex flex-col">
        {manifest.files.map((file) => (
          <li key={file.key} className="flex h-9 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-base">
              {file.label}
              {copy && file.key === 'platform' ? (
                <span className="text-ink-3 text-sm"> · {copy}</span>
              ) : null}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Скачать: ${file.label}`}
                  onClick={() => actions.download(row, true, file.key)}
                >
                  <DownloadIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-md font-mono text-xs">
                {file.download_name}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      <DownloadButton
        label={manifest.files.length > 1 ? `Скачать ${manifest.files.length}` : 'Скачать'}
        options={[
          {
            id: 'platform',
            label: 'Для заливки',
            hint: copy ?? undefined,
            fileName: manifest.files[0]?.download_name,
          },
        ]}
        onDownload={(_, stripMetadata) => actions.downloadAll([row], stripMetadata)}
      />
      {receipt ? <p className="text-ink-3 text-sm">{receipt}</p> : null}
      {album ? (
        <p className="flex items-center gap-1 text-sm">
          <span className="min-w-0 truncate">Альбом: «{album}»</span>
          <Button
            variant="link"
            size="inline"
            className="text-sm"
            onClick={() => void copyAlbum(album)}
          >
            <CopyIcon className="size-3.5" />
            Копировать
          </Button>
        </p>
      ) : null}
    </InfoSection>
  )
}
