import { InfoSection } from '@contentops/ui/components/info-panel'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useState } from 'react'
import { useIntegrations } from '@/data/integrations'
import { SOURCE_WORDS } from '@/objects/source-words'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { useObjectPage } from '../object-context'

const OLD_NAME_KIND: Record<'folder' | 'file' | 'album' | 'number', string> = {
  folder: 'папка',
  file: 'файл',
  album: 'альбом',
  number: 'номер',
}

/**
 * На Я.Диске или на Dropbox (DESIGN §4.4, §1.1): путь моноширинным 12, «Открыть на Я.Диске ↗»
 * («Открыть в Dropbox ↗») и свёрнутые «Старые имена». Имена с фанами приходят только тем, кто
 * видит заказ.
 */
export function YdiskSection() {
  const { detail, model } = useObjectPage()
  const [open, setOpen] = useState(false)
  const source = detail.ydisk.source ?? 'ydisk'
  const words = SOURCE_WORDS[source]
  const disk = useIntegrations().data?.find(
    (integration) =>
      integration.kind === source &&
      integration.model === model.code &&
      integration.state !== 'working',
  )
  const oldNames = detail.ydisk.old_names
  // Объект без исходной папки (сделан в ContentOps) и без старых имён: секции нечего показать.
  if (!detail.ydisk.path && oldNames.length === 0) return null

  return (
    <InfoSection title={words.on}>
      <p className="break-all font-mono text-muted-foreground text-xs">{detail.ydisk.path}</p>
      {disk ? <IntegrationPhrase line={disk.line} wrap /> : null}
      {detail.ydisk.url ? (
        <a
          href={detail.ydisk.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 self-start text-primary-ink text-sm hover:underline"
        >
          {words.open}
          <ExternalLinkIcon className="size-3.5" />
        </a>
      ) : null}
      {oldNames.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="flex items-center gap-1 self-start text-sm"
          >
            <ChevronRightIcon
              className={cn(
                'size-4 text-ink-3 transition-transform duration-120',
                open && 'rotate-90',
              )}
            />
            Старые имена · {oldNames.length}
          </button>
          {open ? (
            <ul className="flex flex-col gap-1 pl-5">
              {oldNames.map((name) => (
                <li key={`${name.kind}-${name.name}`} className="flex min-w-0 flex-col">
                  <span className="break-all font-mono text-xs">{name.name}</span>
                  <span className="text-ink-3 text-xs">{OLD_NAME_KIND[name.kind]}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </InfoSection>
  )
}
