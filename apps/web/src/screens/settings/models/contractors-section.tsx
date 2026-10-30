import {
  CONTRACTOR_FORMAT_LABEL,
  type Contractor,
  ContractorFormatSchema,
  type Model,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { PlusIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { usePromoChannels, usePromoContractors } from '@/data/promo'
import { queryKeys } from '@/data/query-keys'
import { AddContractorDialog } from './add-contractor-dialog'

/**
 * Подрядчики промо модели с одним полем формата (DESIGN §4.19, SPEC §7.1): «для заливки»,
 * «мастер» или «совместимая для монтажа»; формат подставляется в следующую передачу.
 * Канал — тот, с которым подрядчик обычно работает.
 */
export function ContractorsSection({ model }: { model: Model }) {
  const contractors = usePromoContractors(model.code)
  const channels = usePromoChannels(model.code)
  const [adding, setAdding] = useState(false)
  const channelName = (id: string | null) =>
    id === null ? 'любой канал' : (channels.data?.find((channel) => channel.id === id)?.name ?? id)
  return (
    <SettingsSection
      title={`Подрядчики промо · ${model.name}`}
      aside={
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <PlusIcon />
          Добавить подрядчика
        </Button>
      }
    >
      {contractors.data?.length === 0 ? (
        <p className="py-3 text-ink-3 text-sm">Подрядчиков пока нет</p>
      ) : null}
      {contractors.data?.map((contractor) => (
        <ContractorRow
          key={contractor.id}
          model={model}
          contractor={contractor}
          detail={[channelName(contractor.channel), contractor.contact].filter(Boolean).join(' · ')}
        />
      ))}
      <AddContractorDialog model={model} open={adding} onOpenChange={setAdding} />
    </SettingsSection>
  )
}

function ContractorRow({
  model,
  contractor,
  detail,
}: {
  model: Model
  contractor: Contractor
  detail: string
}) {
  const api = useApi()
  const toast = useActionToast()
  const labelId = useId()
  const update = useIntentMutation<Contractor['format'], Contractor>({
    failed: 'Формат не сохранился',
    run: (format, key) =>
      api.settings.updateContractor({
        params: { model: model.code, contractor: contractor.id },
        body: { format },
        ifMatch: contractor.version,
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.promoContractors(model.code)],
    onSuccess: (saved) =>
      toast.show({
        message: `Сохранено · ${saved.name} · ${CONTRACTOR_FORMAT_LABEL[saved.format]}`,
      }),
  })
  return (
    <SettingsRow label={<span id={labelId}>{contractor.name}</span>} detail={detail}>
      <Select
        value={contractor.format}
        disabled={update.isPending}
        onValueChange={(value) => {
          const format = ContractorFormatSchema.safeParse(value)
          if (format.success && format.data !== contractor.format) {
            update.start(format.data)
          }
        }}
      >
        <SelectTrigger aria-labelledby={labelId} className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ContractorFormatSchema.options.map((format) => (
            <SelectItem key={format} value={format}>
              {CONTRACTOR_FORMAT_LABEL[format]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}
