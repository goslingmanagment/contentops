import type { Model, Threshold } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { PlusIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { AddExceptionForm } from './add-exception-form'
import { ThresholdConflict, ThresholdField, useThresholdEdit } from './threshold-field'
import { scopeName, scopeOptions, type ThresholdGroup } from './threshold-value'

interface ThresholdRowProps {
  group: ThresholdGroup
  models: readonly Model[]
  onRemove: (exception: Threshold, name: string) => void
  removing: boolean
}

/**
 * Порог (DESIGN §4.19): слева название, справа значение с единицей. Под ним исключения для
 * страницы или типа вложенными строками и «+ для страницы или типа…».
 */
export function ThresholdRow({ group, models, onRemove, removing }: ThresholdRowProps) {
  const { base, exceptions } = group
  const inputId = useId()
  const edit = useThresholdEdit(base, null)
  const [adding, setAdding] = useState(false)
  const options = scopeOptions(models, exceptions)

  return (
    <SettingsRow
      label={<label htmlFor={inputId}>{base.label}</label>}
      below={
        <>
          <ThresholdConflict edit={edit} />
          <div className="-mt-1 mb-2 flex flex-col pl-6">
            {exceptions.map((exception) => (
              <ExceptionRow
                key={`${exception.scope}:${exception.scope_value}:${exception.version}`}
                threshold={exception}
                models={models}
                onRemove={onRemove}
                removing={removing}
              />
            ))}
            {adding ? (
              <AddExceptionForm base={base} groups={options} onClose={() => setAdding(false)} />
            ) : options.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2.5 self-start text-muted-foreground"
                onClick={() => setAdding(true)}
              >
                <PlusIcon />
                для страницы или типа…
              </Button>
            ) : null}
          </div>
        </>
      }
    >
      <ThresholdField threshold={base} edit={edit} inputId={inputId} />
    </SettingsRow>
  )
}

interface ExceptionRowProps {
  threshold: Threshold
  models: readonly Model[]
  onRemove: (exception: Threshold, name: string) => void
  removing: boolean
}

/** Исключение: «Лайф» и серым «тип», своё значение и «Убрать». */
function ExceptionRow({ threshold, models, onRemove, removing }: ExceptionRowProps) {
  const name = scopeName(threshold, models)
  const edit = useThresholdEdit(threshold, name.name)
  return (
    <div className="flex flex-col">
      <div className="flex min-h-12 items-center gap-6 py-1.5">
        <p className="min-w-0 flex-1 truncate">
          {name.name}
          <span className="ml-2 text-ink-3 text-sm">{name.kind}</span>
        </p>
        <ThresholdField
          threshold={threshold}
          edit={edit}
          inputLabel={`${threshold.label} для ${name.name}`}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={removing}
              onClick={() => onRemove(threshold, name.name)}
            >
              Убрать
            </Button>
          }
        />
      </div>
      <ThresholdConflict edit={edit} />
    </div>
  )
}
