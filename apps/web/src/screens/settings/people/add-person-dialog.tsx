import {
  type AddPersonCommand,
  AddPersonCommandSchema,
  type Model,
  type PersonCreated,
  ROLE_LABEL,
  RoleSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
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
import { useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { ChoiceSection } from '../shared/choice-chips'
import { SecretOnce } from '../shared/secret-once'

interface AddPersonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: readonly Model[]
}

/**
 * «Добавить человека» (DESIGN §3.9, §4.19; окно 480): имя, логин, роль, модели. После
 * ответа сервера окно показывает временный пароль — один раз.
 */
export function AddPersonDialog({ open, onOpenChange, models }: AddPersonDialogProps) {
  const [created, setCreated] = useState<PersonCreated | null>(null)
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setCreated(null)
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-120">
        {created ? (
          <CreatedView created={created} onDone={() => close(false)} />
        ) : open ? (
          <AddPersonForm models={models} onCancel={() => close(false)} onCreated={setCreated} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface AddPersonFormProps {
  models: readonly Model[]
  onCancel: () => void
  onCreated: (created: PersonCreated) => void
}

const ROLE_CHOICES = RoleSchema.options.map((role) => ({ value: role, label: ROLE_LABEL[role] }))

function AddPersonForm({ models, onCancel, onCreated }: AddPersonFormProps) {
  const api = useApi()
  const nameId = useId()
  const loginId = useId()
  const form = useForm<AddPersonCommand>({
    resolver: zodResolver(AddPersonCommandSchema),
    defaultValues: { name: '', login: '', role: 'manager', models: [] },
  })
  const add = useIntentMutation<AddPersonCommand, PersonCreated>({
    failed: 'Человек не добавлен',
    run: (body, key) => api.settings.addPerson({ body, idempotencyKey: key }),
    invalidates: () => [queryKeys.people()],
    onSuccess: onCreated,
  })
  const role = form.watch('role')
  const { errors } = form.formState

  return (
    <form onSubmit={form.handleSubmit((body) => add.start(body))} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Добавить человека</DialogTitle>
        <DialogDescription className="sr-only">Имя, логин, роль и модели</DialogDescription>
      </DialogHeader>
      <FormField htmlFor={nameId} label="Имя" error={errors.name?.message}>
        <Input id={nameId} autoFocus {...form.register('name')} />
      </FormField>
      <FormField
        htmlFor={loginId}
        label="Логин"
        hint="Латиница, цифры, точка; с буквы"
        error={errors.login?.message}
      >
        <Input id={loginId} autoComplete="off" {...form.register('login')} />
      </FormField>
      <Controller
        control={form.control}
        name="role"
        render={({ field }) => (
          <ChoiceSection
            label="Роль"
            options={ROLE_CHOICES}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <ModelsField models={models} role={role} form={form} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        <Button type="submit" pending={add.isPending}>
          Добавить
        </Button>
      </DialogFooter>
    </form>
  )
}

interface ModelsFieldProps {
  models: readonly Model[]
  role: AddPersonCommand['role']
  form: ReturnType<typeof useForm<AddPersonCommand>>
}

/** Модели галочками; владельцу выбирать нечего — у него все модели. */
function ModelsField({ models, role, form }: ModelsFieldProps) {
  const baseId = useId()
  return (
    <fieldset className="flex min-h-14 flex-col gap-2">
      <legend className="pb-2 text-ink-3 text-sm">Модели</legend>
      {role === 'owner' ? (
        <p className="text-muted-foreground">все модели</p>
      ) : (
        <Controller
          control={form.control}
          name="models"
          render={({ field }) => (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {models.map((model) => {
                const id = `${baseId}-${model.code}`
                const checked = field.value.includes(model.code)
                return (
                  <label key={model.code} htmlFor={id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(next) =>
                        field.onChange(
                          next === true
                            ? [...field.value, model.code]
                            : field.value.filter((code) => code !== model.code),
                        )
                      }
                    />
                    {model.name}
                  </label>
                )
              })}
            </div>
          )}
        />
      )}
    </fieldset>
  )
}

function CreatedView({ created, onDone }: { created: PersonCreated; onDone: () => void }) {
  const { person } = created
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>
          {person.name} · {ROLE_LABEL[person.role]}
        </DialogTitle>
        <DialogDescription>
          Логин <span className="font-mono text-foreground text-xs">{person.login}</span>
        </DialogDescription>
      </DialogHeader>
      <SecretOnce secret={created.temporary_password} label="Временный пароль" />
      <DialogFooter>
        <Button onClick={onDone}>Готово</Button>
      </DialogFooter>
    </div>
  )
}
