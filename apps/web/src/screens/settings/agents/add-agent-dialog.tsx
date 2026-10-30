import {
  type AddAgentCommand,
  AddAgentCommandSchema,
  type Agent,
  AgentRoleSchema,
  type Model,
  ROLE_LABEL,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { ModelChecks } from '../people/model-checks'
import { ChoiceSection } from '../shared/choice-chips'

/** Агенту — роль человека в пределах моделей; владельцем агент не бывает (SPEC §11.1). */
export const AGENT_ROLE_CHOICES = AgentRoleSchema.options.map((role) => ({
  value: role,
  label: ROLE_LABEL[role],
}))

interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: readonly Model[]
}

/**
 * «Добавить агента» (DESIGN §4.19; окно 480): имя, роль, модели. Fyper — агент с ролью
 * «Только чтение». Токен выдаётся отдельно — «Выдать токен» в строке агента.
 */
export function AddAgentDialog({ open, onOpenChange, models }: AddAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {open ? <AddAgentForm models={models} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

interface AddAgentFormProps {
  models: readonly Model[]
  onClose: () => void
}

function AddAgentForm({ models, onClose }: AddAgentFormProps) {
  const api = useApi()
  const toast = useActionToast()
  const nameId = useId()
  const form = useForm<AddAgentCommand>({
    resolver: zodResolver(AddAgentCommandSchema),
    defaultValues: { name: '', role: 'reader', models: [] },
  })
  const add = useIntentMutation<AddAgentCommand, Agent>({
    failed: 'Агент не добавлен',
    run: (body, key) => api.settings.addAgent({ body, idempotencyKey: key }),
    invalidates: () => [queryKeys.agents()],
    onSuccess: (agent) => {
      onClose()
      toast.show({ message: `Агент добавлен · ${agent.name}` })
    },
  })
  const name = form.watch('name')
  const role = form.watch('role')
  const { errors } = form.formState

  return (
    <form onSubmit={form.handleSubmit((body) => add.start(body))} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Добавить агента</DialogTitle>
        <DialogDescription className="sr-only">Имя, роль и модели агента</DialogDescription>
      </DialogHeader>
      <FormField htmlFor={nameId} label="Имя" error={errors.name?.message}>
        <Input
          id={nameId}
          autoFocus
          autoComplete="off"
          placeholder="Приёмка, Заказы, Fyper"
          {...form.register('name')}
        />
      </FormField>
      <Controller
        control={form.control}
        name="role"
        render={({ field }) => (
          <ChoiceSection
            label="Роль"
            options={AGENT_ROLE_CHOICES}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <section className="flex min-h-14 flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Модели</h3>
        <Controller
          control={form.control}
          name="models"
          render={({ field }) => (
            <ModelChecks
              holder={{ name, role, models: field.value }}
              models={models}
              disabled={add.isPending}
              onToggle={(code, checked) =>
                field.onChange(
                  checked ? [...field.value, code] : field.value.filter((item) => item !== code),
                )
              }
            />
          )}
        />
      </section>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" pending={add.isPending}>
          Добавить
        </Button>
      </DialogFooter>
    </form>
  )
}
