import type { HubOrder, HubShootingStep } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Input } from '@contentops/ui/components/input'
import { useId, useState } from 'react'
import { useRole } from '@/data/session'
import type { HubOrderActions } from './use-hub-order-actions'

const STEP_LABEL: Record<HubShootingStep, string> = {
  at_model: 'Передать модели',
  partly: 'Сдан частично',
  shot: 'Снят',
  revision: 'Правка',
  refused: 'Отказ модели',
}

/** Что спросить у человека перед шагом. */
const ASK: Partial<Record<HubShootingStep, { label: string; required: boolean }>> = {
  partly: { label: 'Что пришло и что ещё ждём', required: false },
  revision: { label: 'Что исправить', required: false },
  refused: { label: 'Почему модель отказалась', required: true },
}

/**
 * Шаги съёмки (пакет C3): передать модели со сроком, сдан частично, снят, правка, отказ. Шаг
 * пишется в Hub от имени вошедшего человека; ведёт его КМ модели, пока его нет — ведущий
 * кастомы, иначе владелец. Hub отказывает тому, кто шаг не ведёт, — карточка так и скажет.
 */
export function HubOrderSteps({ order, actions }: { order: HubOrder; actions: HubOrderActions }) {
  const role = useRole()
  const [open, setOpen] = useState<HubShootingStep | null>(null)
  const [text, setText] = useState('')
  const [deadline, setDeadline] = useState(order.deadline ?? '')
  const id = useId()
  if (role === 'reader' || order.steps.length === 0) {
    return order.leader ? <Leader order={order} /> : null
  }
  const ask = open ? ASK[open] : undefined
  const submit = (step: HubShootingStep) => {
    const note = text.trim()
    if (ASK[step]?.required && note === '') return
    actions.step(order, {
      step,
      ...(step === 'at_model' && deadline ? { deadline } : {}),
      ...(note ? { note } : {}),
    })
    setOpen(null)
    setText('')
  }
  return (
    <InfoSection title="Шаг съёмки">
      <div className="flex flex-col gap-3">
        {order.leader ? <Leader order={order} /> : null}
        <div className="flex flex-wrap gap-1.5">
          {order.steps.map((step, index) => (
            <Button
              key={step}
              size="sm"
              variant={index === 0 ? 'default' : step === 'refused' ? 'outline' : 'secondary'}
              disabled={actions.stepping}
              onClick={() => {
                if (step === 'shot') return submit(step)
                setOpen(open === step ? null : step)
              }}
            >
              {STEP_LABEL[step]}
            </Button>
          ))}
        </div>
        {open === 'at_model' ? (
          <form
            className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault()
              submit('at_model')
            }}
          >
            <label htmlFor={id} className="flex flex-col gap-1 text-ink-3 text-sm">
              Срок, до какого дня
              <Input
                id={id}
                type="date"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
                className="w-44"
              />
            </label>
            <Button type="submit" size="sm" disabled={actions.stepping}>
              Передать модели
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Отмена
            </Button>
          </form>
        ) : null}
        {open && ask ? (
          <form
            className="flex flex-col gap-2 rounded-xl border border-border p-3"
            onSubmit={(event) => {
              event.preventDefault()
              submit(open)
            }}
          >
            <label htmlFor={id} className="text-ink-3 text-sm">
              {ask.label}
            </label>
            <Input id={id} value={text} onChange={(event) => setText(event.target.value)} />
            <div className="flex gap-1.5">
              <Button
                type="submit"
                size="sm"
                disabled={actions.stepping || (ask.required && text.trim() === '')}
              >
                {STEP_LABEL[open]}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
                Отмена
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </InfoSection>
  )
}

function Leader({ order }: { order: HubOrder }) {
  if (!order.leader) return null
  const who = order.leader.name ?? 'владелец'
  return (
    <p className="text-sm">
      <span className="text-ink-3">Ведёт: </span>
      {who}
      {order.leader.shooting ? null : <span className="text-ink-3"> · в Workboard</span>}
    </p>
  )
}
