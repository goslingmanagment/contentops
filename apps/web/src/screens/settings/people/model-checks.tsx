import type { Model, ModelCode, Role } from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { useId } from 'react'

/** Чьи права: человек или агент — имя для подписи, роль и выданные модели. */
interface Holder {
  name: string
  role: Role
  models: readonly ModelCode[]
}

interface ModelChecksProps {
  holder: Holder
  models: readonly Model[]
  disabled: boolean
  onToggle: (code: ModelCode, checked: boolean) => void
}

/** Модели галочками; у владельца — все модели, без галочек. */
export function ModelChecks({ holder, models, disabled, onToggle }: ModelChecksProps) {
  const baseId = useId()
  if (holder.role === 'owner') {
    return <p className="text-muted-foreground text-sm">все модели</p>
  }
  return (
    <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <legend className="sr-only">Модели: {holder.name}</legend>
      {models.map((model) => {
        const id = `${baseId}-${model.code}`
        return (
          <label key={model.code} htmlFor={id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={holder.models.includes(model.code)}
              disabled={disabled}
              onCheckedChange={(checked) => onToggle(model.code, checked === true)}
            />
            {model.name}
          </label>
        )
      })}
    </fieldset>
  )
}
