import {
  formatDate,
  formatNumber,
  pastVerb,
  SHOOTING_TASK_KIND_LABEL,
  type ShootingTask,
  type ShootingTaskKind,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FieldHeader, HeaderAction } from '@contentops/ui/components/field-header'
import { Input } from '@contentops/ui/components/input'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Textarea } from '@contentops/ui/components/textarea'
import { PlusIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useToday } from '@/data/api-session'
import { useRole } from '@/data/session'
import { useShootingTaskActions, useShootingTasks } from '@/data/shooting-tasks'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { useCurrentModel } from '@/shell/model/model-context'
import { ShootingTabs } from './shooting-tabs'

const KINDS: readonly ShootingTaskKind[] = ['set', 'fyp', 'other']

/**
 * «Съёмка › ТЗ» (пакет C3): задания модели, что не заказ фана, — сет, пачка FYP, — со сроком и
 * сдачей. Заводят и отмечают владелец и КМ; «Только чтение» видит список.
 */
export function TasksView() {
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const list = useShootingTasks(model.code)
  const actions = useShootingTaskActions(model.code)
  const [adding, setAdding] = useState(false)
  const data = list.data
  return (
    <FieldLayout>
      <FieldHeader
        title="Съёмка"
        count={data?.open.length}
        nav={<ShootingTabs value="tasks" />}
        actions={
          editable ? (
            <HeaderAction icon={<PlusIcon />} label="Новое ТЗ" onClick={() => setAdding(true)} />
          ) : null
        }
      />
      <div className="@container -mx-7 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-7 pt-2 pb-8">
        <QueryErrorLine query={list} hasData={data !== undefined} />
        {adding ? (
          <NewTaskForm
            pending={actions.creating}
            onCancel={() => setAdding(false)}
            onSubmit={(body) => {
              actions.create(body)
              setAdding(false)
            }}
          />
        ) : null}
        {data && data.open.length === 0 && !adding ? (
          <EmptyState>
            {editable
              ? `ТЗ для ${model.name_genitive} нет. Сет или пачку FYP со сроком заводят кнопкой «Новое ТЗ»`
              : `ТЗ для ${model.name_genitive} нет`}
          </EmptyState>
        ) : null}
        {data && data.open.length > 0 ? (
          <TaskGroup title="Ждём" tasks={data.open} editable={editable} actions={actions} />
        ) : null}
        {data && data.done.length > 0 ? (
          <TaskGroup
            title="Сдано за 14 дней"
            tasks={data.done}
            editable={false}
            actions={actions}
          />
        ) : null}
      </div>
    </FieldLayout>
  )
}

function TaskGroup({
  title,
  tasks,
  editable,
  actions,
}: {
  title: string
  tasks: readonly ShootingTask[]
  editable: boolean
  actions: ReturnType<typeof useShootingTaskActions>
}) {
  const today = useToday()
  return (
    <section aria-label={title}>
      <div className="flex h-11 items-end px-2 pb-2">
        <h2 className="flex items-baseline gap-2 text-lg">
          {title}
          <span className="font-normal text-ink-3 text-sm tabular-nums">
            {formatNumber(tasks.length)}
          </span>
        </h2>
      </div>
      <ul className="-mx-2 flex flex-col">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-muted/50"
          >
            <span className="w-14 shrink-0 text-ink-3 text-sm">
              {SHOOTING_TASK_KIND_LABEL[task.kind]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{task.title}</span>
              {task.note ? (
                <span className="block truncate text-ink-3 text-sm">{task.note}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-sm">
              {task.handed_in ? (
                <span className="text-ink-3">
                  {pastVerb('отметил', task.handed_in.by.gender)} сдачу: {task.handed_in.by.name}
                </span>
              ) : task.overdue_days ? (
                <StatusWord sign="trouble">просрочено</StatusWord>
              ) : task.deadline ? (
                `до ${formatDate(task.deadline, today)}`
              ) : (
                <span className="text-ink-3">без срока</span>
              )}
            </span>
            {editable && !task.handed_in ? (
              <span className="flex shrink-0 gap-1.5">
                <Button size="sm" disabled={actions.busy} onClick={() => actions.handIn(task)}>
                  Сдано
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actions.busy}
                  onClick={() => actions.cancel(task)}
                >
                  Убрать
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function NewTaskForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean
  onSubmit: (body: {
    title: string
    kind: ShootingTaskKind
    note: string | null
    deadline: string | null
  }) => void
  onCancel: () => void
}) {
  const id = useId()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ShootingTaskKind>('set')
  const [deadline, setDeadline] = useState('')
  const [note, setNote] = useState('')
  return (
    <form
      className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim() === '') return
        onSubmit({
          title: title.trim(),
          kind,
          note: note.trim() || null,
          deadline: deadline || null,
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Что снять">
        {KINDS.map((one) => (
          <Button
            key={one}
            type="button"
            size="sm"
            variant={kind === one ? 'secondary' : 'outline'}
            aria-pressed={kind === one}
            onClick={() => setKind(one)}
          >
            {SHOOTING_TASK_KIND_LABEL[one]}
          </Button>
        ))}
      </div>
      <label htmlFor={`${id}-title`} className="flex flex-col gap-1 text-ink-3 text-sm">
        Название
        <Input
          id={`${id}-title`}
          value={title}
          placeholder="Сет у окна в белом"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label htmlFor={`${id}-deadline`} className="flex flex-col gap-1 text-ink-3 text-sm">
        Срок
        <Input
          id={`${id}-deadline`}
          type="date"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          className="w-44"
        />
      </label>
      <label htmlFor={`${id}-note`} className="flex flex-col gap-1 text-ink-3 text-sm">
        Что важно
        <Textarea
          id={`${id}-note`}
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="flex gap-1.5">
        <Button type="submit" disabled={pending || title.trim() === ''}>
          Завести ТЗ
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
