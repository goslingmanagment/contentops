import { formatNumber, type Handoff } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

interface HandoffFilesProps {
  handoff: Handoff
}

/**
 * Что внутри ZIP (DESIGN §4.17): имя архива и список файлов свёрнутым блоком — ровно то,
 * что несёт передача (после «Убрать их» и при передаче выбранного — не вся подборка),
 * под именами из архива (naming §6) и `manifest.csv` последним. Пока ZIP не собран —
 * ключи материалов.
 */
export function HandoffFiles({ handoff }: HandoffFilesProps) {
  const [open, setOpen] = useState(false)
  const files = handoff.zip_files.length > 0 ? handoff.zip_files : handoff.member_keys
  const zipName = handoff.zip_name
  return (
    <InfoSection
      title="ZIP"
      aside={
        <Button
          variant="link"
          size="inline"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          Список файлов · {formatNumber(handoff.member_keys.length)}
          <ChevronDownIcon
            aria-hidden
            className={cn('size-4 transition-transform duration-120', open && 'rotate-180')}
          />
        </Button>
      }
    >
      {zipName ? <p className="truncate font-mono text-xs">{zipName}</p> : null}
      {open ? (
        <ol className="flex max-h-60 flex-col overflow-y-auto rounded-xl bg-muted px-3.5 py-2.5 font-mono text-xs">
          {files.map((key) => (
            <li key={key} className="shrink-0 truncate leading-5">
              {key}
            </li>
          ))}
        </ol>
      ) : null}
    </InfoSection>
  )
}
