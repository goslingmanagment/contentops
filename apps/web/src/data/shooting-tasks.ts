import type { CreateShootingTaskCommand, ModelCode, ShootingTask } from '@contentops/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/** «Съёмка › ТЗ» (пакет C3): задания модели, что не заказ фана. */
export function useShootingTasks(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.shootingTasks(model),
    queryFn: ({ signal }) => api.shootingTasks.list({ params: { model }, signal }),
  })
}

export function useShootingTaskActions(model: ModelCode) {
  const api = useApi()
  const toast = useActionToast()
  const queryClient = useQueryClient()
  const reread = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.shootingTasks(model) })

  const create = useIntentMutation<CreateShootingTaskCommand, ShootingTask>({
    failed: 'ТЗ не сохранилось',
    run: (body, key) => api.shootingTasks.create({ params: { model }, body, idempotencyKey: key }),
    onSuccess: (task) => {
      reread()
      toast.show({ message: `ТЗ «${task.title}» заведено` })
    },
  })
  const handIn = useIntentMutation<ShootingTask, ShootingTask>({
    failed: 'Сдача не отмечена',
    run: (task, key) =>
      api.shootingTasks.handIn({ params: { model, task: task.id }, idempotencyKey: key }),
    onSuccess: (task) => {
      reread()
      toast.show({ message: `«${task.title}»: сдано` })
    },
  })
  const cancel = useIntentMutation<ShootingTask, ShootingTask>({
    failed: 'ТЗ не убралось',
    run: (task, key) =>
      api.shootingTasks.cancel({ params: { model, task: task.id }, idempotencyKey: key }),
    onSuccess: (task) => {
      reread()
      toast.show({ message: `«${task.title}» убрано` })
    },
  })
  return {
    create: (body: CreateShootingTaskCommand) => create.start(body),
    creating: create.isPending,
    handIn: (task: ShootingTask) => handIn.start(task),
    cancel: (task: ShootingTask) => cancel.start(task),
    busy: handIn.isPending || cancel.isPending,
  }
}
