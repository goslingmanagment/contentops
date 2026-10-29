import {
  CONTRACTOR_FORMAT_LABEL,
  type Contractor,
  ContractorFormatSchema,
  type ModelCode,
} from '@contentops/contracts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useId } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { usePromoChannels } from '@/data/promo'
import { queryKeys } from '@/data/query-keys'
import { useContractors } from '@/data/settings'

/** Короткие подписи в поле: полная «компактные файлы для публикации» в нём не помещается. */
const FORMAT_CHOICE: Record<Contractor['format'], string> = {
  compact: 'компактные',
  masters: 'мастера для монтажа',
}

/**
 * Подрядчики промо с форматом передачи: компактные файлы или мастера для монтажа. Каналы
 * подписаны именами каналов модели, у которой они открыты.
 */
export function ContractorsSection({ model }: { model: ModelCode }) {
  const contractors = useContractors()
  const channels = usePromoChannels(model)
  if (!contractors.data) {
    return null
  }
  const channelName = (id: string) =>
    channels.data?.find((channel) => channel.id === id)?.name ?? id
  return (
    <SettingsSection title="Подрядчики промо">
      {contractors.data.map((contractor) => (
        <ContractorRow
          key={contractor.id}
          contractor={contractor}
          channels={contractor.channels.map(channelName).join(', ')}
        />
      ))}
    </SettingsSection>
  )
}

function ContractorRow({ contractor, channels }: { contractor: Contractor; channels: string }) {
  const api = useApi()
  const toast = useActionToast()
  const labelId = useId()
  const update = useIntentMutation<Contractor['format'], Contractor>({
    failed: 'Формат не сохранился',
    run: (format, key) =>
      api.settings.updateContractor({
        params: { contractor: contractor.id },
        body: { format },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.contractors()],
    onSuccess: (saved) =>
      toast.show({
        message: `Сохранено · ${saved.name} · ${CONTRACTOR_FORMAT_LABEL[saved.format]}`,
      }),
  })
  return (
    <SettingsRow label={<span id={labelId}>{contractor.name}</span>} detail={channels}>
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
        <SelectTrigger aria-labelledby={labelId} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ContractorFormatSchema.options.map((format) => (
            <SelectItem key={format} value={format}>
              {FORMAT_CHOICE[format]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  )
}
