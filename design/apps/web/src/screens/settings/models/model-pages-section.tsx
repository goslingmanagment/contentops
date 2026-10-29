import { type Account, type Model, UNIQ_LEVEL_LABEL } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { usePromoChannels } from '@/data/promo'
import { useModelPeople } from '@/data/settings'
import { useIsOwner } from '../shared/use-is-owner'
import { AddAccountDialog } from './add-account-dialog'

interface ModelPagesSectionProps {
  model: Model
}

/** «LoraViex · Hub: lora-2 · обычно выкладывает Диана · версии: мягко». */
function pageDetail(account: Account, assignee: string | null): string {
  return [
    account.handle,
    account.hub_page ? `Hub: ${account.hub_page}` : 'Hub не настроен',
    assignee ? `обычно выкладывает ${assignee}` : null,
    `версии: ${UNIQ_LEVEL_LABEL[account.uniq_level]}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** Модель и её страницы; «Норма» ведёт в редактор страницы и нормы недели. */
export function ModelPagesSection({ model }: ModelPagesSectionProps) {
  const owner = useIsOwner()
  const channels = usePromoChannels(model.code)
  const people = useModelPeople(model.code)
  /** «Обычно выкладывает Никита»: имена людей модели видит и КМ. */
  const nameOf = (id: string | null) =>
    id ? (people.data?.find((person) => person.id === id)?.name ?? null) : null
  const [adding, setAdding] = useState(false)
  const pages = [...model.accounts].sort((left, right) => left.position - right.position)

  return (
    <SettingsSection
      title={model.name}
      description={
        <>
          <span className="font-mono text-xs">{model.code}</span> · Москва
        </>
      }
      aside={
        owner ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Добавить страницу
          </Button>
        ) : null
      }
    >
      {pages.length === 0 ? (
        <SettingsRow label="Страниц пока нет" detail="Добавьте первую, чтобы ставить план" />
      ) : null}
      {pages.map((account) => (
        <SettingsRow
          key={account.code}
          label={
            <>
              {account.label}
              <span className="ml-2 font-mono text-ink-3 text-xs">{account.code}</span>
            </>
          }
          detail={pageDetail(account, nameOf(account.usual_assignee))}
        >
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/$model/settings/pages/$account"
              params={{ model: model.code, account: account.code }}
            >
              Норма
              <ChevronRightIcon />
            </Link>
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow
        label="Каналы промо"
        detail={
          channels.data ? channels.data.map((channel) => channel.name).join(', ') || 'нет' : '…'
        }
      />
      {owner ? <AddAccountDialog model={model} open={adding} onOpenChange={setAdding} /> : null}
    </SettingsSection>
  )
}
