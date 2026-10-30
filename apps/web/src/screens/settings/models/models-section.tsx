import { Button } from '@contentops/ui/components/button'
import { SettingsSectionSkeleton } from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { PlusIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useModels } from '@/data/session'
import { SettingsPage } from '../settings-layout'
import { useIsOwner } from '../shared/use-is-owner'
import { AddModelDialog } from './add-model-dialog'
import { ContractorsSection } from './contractors-section'
import { ModelPagesSection } from './model-pages-section'

/**
 * «Модели и страницы» (DESIGN §4.19): модель — код, название, часовой пояс; страницы
 * строками с Hub, кто обычно выкладывает, уровнем версий и ссылкой на норму; каналы
 * промо; подрядчики с форматом. КМ видит «Страницы и нормы» своих моделей.
 */
export function ModelsSection() {
  const owner = useIsOwner()
  const models = useModels()
  const [adding, setAdding] = useState(false)

  return (
    <SettingsPage
      title={owner ? 'Модели и страницы' : 'Страницы и нормы'}
      refreshing={models.isFetching && !models.isPending}
      actions={
        owner ? (
          <Button onClick={() => setAdding(true)}>
            <PlusIcon />
            Добавить модель
          </Button>
        ) : undefined
      }
    >
      {models.isError && !models.data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void models.refetch()} />
      ) : null}
      {models.isPending ? <SettingsSectionSkeleton rows={5} /> : null}
      {models.data?.map((model) => (
        <Fragment key={model.code}>
          <ModelPagesSection model={model} />
          {owner ? <ContractorsSection model={model} /> : null}
        </Fragment>
      ))}
      {owner ? <AddModelDialog open={adding} onOpenChange={setAdding} /> : null}
    </SettingsPage>
  )
}
