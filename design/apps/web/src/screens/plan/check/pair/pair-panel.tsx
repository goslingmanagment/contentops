import type { CheckCaseKind, LocalDate } from '@contentops/contracts'
import { InfoPanel } from '@contentops/ui/components/info-panel'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { PanelHead, PanelTitle } from '@contentops/ui/components/panel-pin'
import { type ComponentType, Fragment } from 'react'
import { RecentEvents } from '@/objects/recent-events'
import { CaseStatus } from '../case-status'
import { caseSubtitle, caseTitle } from '../case-text'
import type { CaseBodyProps } from './case-body'
import { PairBody, VariantsBody, VaultBody } from './pair-bodies'
import { PairDetails } from './pair-details'
import { UnplannedBody } from './unplanned-body'

const BODY: Record<CheckCaseKind, ComponentType<CaseBodyProps>> = {
  candidate: PairBody,
  mismatch: PairBody,
  conflict: PairBody,
  partial: PairBody,
  surface: PairBody,
  variants: VariantsBody,
  unplanned: UnplannedBody,
  vault_missing: VaultBody,
  vault_stale: VaultBody,
}

interface PairPanelProps extends CaseBodyProps {
  today: LocalDate
  /** То же меню, что по правому клику на строке (§3.6). */
  menu: ItemMenuModel
  width: 'wide' | 'narrow'
  onClose: () => void
}

/** Заголовок случая — в закреплённом верху панели вместе с решением (§3.4). */
function CaseHeading({ entry, account, today, menu }: PairPanelProps) {
  return (
    <PanelHead>
      <PanelTitle
        title={caseTitle(entry)}
        lines={[
          `${entry.version_label ? `${entry.version_label} · ` : ''}${account.label} · ${caseSubtitle(entry, today)}`,
        ]}
        menu={<ItemMenuButton menu={menu} label="Действия со случаем" size="icon-sm" />}
        status={<CaseStatus verdict={entry.verdict} />}
      />
    </PanelHead>
  )
}

/**
 * Панель пары 400 (DESIGN §4.15): кто, где и когда, пара на глазах, решение и свёрнутое
 * «Подробнее». Вкладка «История» — события объекта, как в журнале.
 */
export function PairPanel(props: PairPanelProps) {
  const { entry, width, onClose } = props
  const Body = BODY[entry.kind]
  return (
    <InfoPanel
      width={width}
      onClose={onClose}
      tabs={[
        {
          value: 'pair',
          label: 'Сведения',
          // Своё содержимое у каждого случая: поиск и выбор не переезжают на соседний.
          content: (
            <Fragment key={entry.id}>
              <CaseHeading {...props} />
              <Body {...props} />
              <PairDetails entry={entry} />
            </Fragment>
          ),
        },
        {
          value: 'history',
          label: 'История',
          content: entry.item_id ? (
            <RecentEvents item={entry.item_id} />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {entry.details.how_checked.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ),
        },
      ]}
    />
  )
}
