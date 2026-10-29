import { Button } from '@contentops/ui/components/button'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { useModels } from '@/data/session'
import { useAiSettings } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { AddServiceForm } from './add-service-form'
import { AiStopLine } from './ai-stop-line'
import { BudgetRow } from './budget-row'
import { ServiceRow } from './service-row'

/**
 * «Сервис ИИ» (DESIGN §4.19, §4.20): сервисы и что они делают, согласие на каждый,
 * бюджет, остановка словами и «Квитанции запросов →». До подключения — один путь:
 * подключить первый сервис.
 */
export function AiSection() {
  const ai = useAiSettings()
  const firstModel = useModels().data?.[0]?.code
  const [adding, setAdding] = useState(false)
  const data = ai.data
  const connected = data !== undefined && data.services.length > 0

  return (
    <SettingsPage title="Сервис ИИ" refreshing={ai.isFetching && !ai.isPending}>
      {ai.isError && !data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void ai.refetch()} />
      ) : null}
      {ai.isPending ? <SettingsSectionSkeleton rows={3} /> : null}
      {data && !connected ? (
        <SettingsSection title="Подключить сервис">
          <AddServiceForm first />
        </SettingsSection>
      ) : null}
      {data && connected ? (
        <>
          <AiStopLine stopped={data.stopped} />
          <SettingsSection
            title="Сервисы"
            aside={
              adding ? null : (
                <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                  <PlusIcon />
                  Добавить сервис
                </Button>
              )
            }
          >
            {data.services.map((service) => (
              <ServiceRow key={service.id} service={service} />
            ))}
            {adding ? <AddServiceForm onDone={() => setAdding(false)} /> : null}
          </SettingsSection>
          <SettingsSection title="Бюджет">
            <BudgetRow
              key={data.budget_month_usd ?? 'none'}
              budget={data.budget_month_usd}
              spent={data.spent_month_usd}
            />
          </SettingsSection>
          {firstModel ? (
            <Button variant="link" size="sm" className="self-start" asChild>
              <Link to="/$model/journal" params={{ model: firstModel }} search={{ who: 'system' }}>
                Квитанции запросов
                <ChevronRightIcon />
              </Link>
            </Button>
          ) : null}
        </>
      ) : null}
    </SettingsPage>
  )
}
