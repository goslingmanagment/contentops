import { formatDate, formatWhen, type ItemFile } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { useClock, useToday } from '@/data/api-session'
import { RecentEvents } from '@/objects/recent-events'
import { useObjectPage } from '../object-context'

/**
 * Вкладка «История» (DESIGN §4.4): версии мастера со «Сравнить v1 / v2», квитанции выдачи
 * («Выдано: … · Диана · 07.08 19:40 · метаданные стёрты») и события объекта из журнала.
 */
export function HistoryTab() {
  const { detail } = useObjectPage()
  const master = detail.files.find((file) => file.role === 'master')
  return (
    <>
      {master && master.versions.length > 1 ? <VersionsList master={master} /> : null}
      <ReceiptsList />
      <InfoSection title="События">
        <RecentEvents item={detail.entry.id} />
      </InfoSection>
    </>
  )
}

function VersionsList({ master }: { master: ItemFile }) {
  const today = useToday()
  const { openFile, setSearch } = useObjectPage()
  const versions = [...master.versions].reverse()
  return (
    <InfoSection
      title="Версии мастера"
      aside={
        <Button
          variant="link"
          size="inline"
          className="text-sm"
          onClick={() =>
            setSearch({ view: 'master', compare: 'v1,v2', t: undefined, v: undefined })
          }
        >
          Сравнить v1 / v2
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {versions.map((version) => (
          <li key={version.no}>
            <button
              type="button"
              onClick={() =>
                openFile('master', {
                  version: version.no === master.current_version ? undefined : version.no,
                })
              }
              className="-mx-2 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-120 hover:bg-accent"
            >
              {[
                `v${version.no}`,
                formatDate(version.on, today),
                version.reason,
                version.no === master.current_version ? 'текущая' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </button>
          </li>
        ))}
      </ul>
    </InfoSection>
  )
}

function ReceiptsList() {
  const { detail } = useObjectPage()
  const now = useClock().now()
  if (detail.receipts.length === 0) {
    return null
  }
  return (
    <InfoSection title="Выдано">
      <ul className="flex flex-col gap-2.5">
        {detail.receipts.map((receipt) => (
          <li key={receipt.id} className="flex min-w-0 flex-col gap-0.5">
            <span className="break-all font-mono text-xs">{receipt.file_name}</span>
            <span className="text-ink-3 text-xs tabular-nums">
              {[
                receipt.by.name,
                formatWhen(receipt.at, now),
                receipt.meta_stripped ? 'метаданные стёрты' : 'с метаданными',
              ].join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </InfoSection>
  )
}
