import type { Model, ModelCode, Person } from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { useId } from 'react'

interface ModelChecksProps {
  person: Person
  models: readonly Model[]
  disabled: boolean
  onToggle: (code: ModelCode, checked: boolean) => void
}

/** Модели галочками; у владельца — все модели, без галочек. */
export function ModelChecks({ person, models, disabled, onToggle }: ModelChecksProps) {
  const baseId = useId()
  if (person.role === 'owner') {
    return <p className="text-muted-foreground text-sm">все модели</p>
  }
  return (
    <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <legend className="sr-only">Модели: {person.name}</legend>
      {models.map((model) => {
        const id = `${baseId}-${model.code}`
        return (
          <label key={model.code} htmlFor={id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={person.models.includes(model.code)}
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
