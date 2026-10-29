import {
  FAN_NAME_CHOICES,
  FAN_NAME_LABEL,
  type FanName,
  isApiError,
  type SetItemFlagsCommand,
} from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Label } from '@contentops/ui/components/label'
import { Switch } from '@contentops/ui/components/switch'
import { useId } from 'react'
import { z } from 'zod'
import { useActionToast } from '@/actions/action-toast-context'
import { useApi } from '@/data/api-session'
import { useObjectDialogs } from '@/objects/dialogs/use-object-dialogs'
import { useItemCommand } from '../actions/use-item-command'
import { useObjectPage } from '../object-context'

const RowsDetailsSchema = z.object({ rows: z.number().int().positive() })

/**
 * Отметки (DESIGN §4.4): «Второй человек в кадре» и у кастома «Имя фана в ролике: есть /
 * нет / не знаю». Поздняя отметка при строках на OnlyFans — окно «Снимет 2 строки на
 * OnlyFans · Снять и отметить».
 */
export function FlagsSection() {
  const { detail, model, canAct } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const dialogs = useObjectDialogs()
  const switchId = useId()
  const entry = detail.entry

  const flags = useItemCommand<SetItemFlagsCommand>({
    failed: 'Отметка не сохранилась',
    run: (body, idempotencyKey) =>
      api.objects.setFlags({
        params: { model: model.code, id: entry.id },
        body,
        ifMatch: detail.version,
        idempotencyKey,
      }),
    handleFailure: (error, body) => {
      const rows = isApiError(error) ? RowsDetailsSchema.safeParse(error.body.details) : null
      if (!rows?.success || body.second_person !== true) {
        return false
      }
      dialogs.open({ kind: 'second-person', items: [entry.id], value: true, rows: rows.data.rows })
      return true
    },
    onSaved: (_saved, body) =>
      toast.show({
        message:
          body.fan_name !== undefined
            ? `Сохранено · ${FAN_NAME_LABEL[body.fan_name]}`
            : body.second_person
              ? 'Отмечено · второй человек в кадре'
              : 'Отметка снята',
      }),
  })

  return (
    <InfoSection title="Отметки">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <Label htmlFor={switchId}>Второй человек в кадре</Label>
        <Switch
          id={switchId}
          checked={entry.second_person}
          disabled={!canAct || flags.isPending}
          onCheckedChange={(checked) => flags.start({ second_person: checked })}
        />
      </div>
      {entry.type === 'custom' && !entry.photo_custom ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm">Имя фана в ролике</span>
          {canAct ? (
            <ChoiceChips<FanName>
              label="Имя фана в ролике"
              choices={FAN_NAME_CHOICES}
              value={entry.fan_name}
              onChange={(fanName) =>
                fanName !== entry.fan_name && flags.start({ fan_name: fanName })
              }
            />
          ) : (
            <span className="text-muted-foreground">
              {entry.fan_name ? FAN_NAME_LABEL[entry.fan_name] : 'не отмечено'}
            </span>
          )}
        </div>
      ) : null}
      {dialogs.element}
    </InfoSection>
  )
}
