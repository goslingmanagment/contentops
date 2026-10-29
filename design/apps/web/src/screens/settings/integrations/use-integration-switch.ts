import type { IntegrationSwitches, IntegrationView, Page } from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

export type SwitchKey = keyof IntegrationSwitches

interface SwitchRequest {
  integration: IntegrationView
  key: SwitchKey
  value: boolean
  /** «Автосверка Hub · Fansly 3» для полоски. */
  label: string
}

/**
 * Выключатели интеграций (§4.19). Пока ответ не пришёл, выключатель стоит в новом
 * положении и заблокирован; «Сохранено» — только после ответа, с «Отменить».
 */
export function useIntegrationSwitch() {
  const api = useApi()
  const toast = useActionToast()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map())

  const pendingKey = (integration: IntegrationView, key: SwitchKey) => `${integration.id}:${key}`
  const settle = (request: SwitchRequest) =>
    setPending((current) => {
      const next = new Map(current)
      next.delete(pendingKey(request.integration, request.key))
      return next
    })

  const replaceInList = (updated: IntegrationView) =>
    queryClient.setQueryData<Page<IntegrationView>>(
      queryKeys.integrations(),
      (page) =>
        page && {
          ...page,
          items: page.items.map((item) => (item.id === updated.id ? updated : item)),
        },
    )

  const mutation = useIntentMutation<SwitchRequest, IntegrationView>({
    failed: 'Не переключилось',
    run: async (request, idempotencyKey) => {
      try {
        const updated = await api.admin.updateIntegration({
          params: { integration: request.integration.id },
          body: { switches: { [request.key]: request.value } },
          idempotencyKey,
        })
        // Новое положение приходит в список раньше, чем выключатель отпускает ожидание.
        replaceInList(updated)
        return updated
      } finally {
        settle(request)
      }
    },
    invalidates: () => [queryKeys.counters()],
    onSuccess: (updated, request) =>
      toast.show({
        message: `${request.value ? 'Включено' : 'Выключено'} · ${request.label}`,
        undoable: true,
        action: {
          label: 'Отменить',
          onSelect: () => toggle({ ...request, integration: updated, value: !request.value }),
        },
      }),
  })

  const toggle = (request: SwitchRequest) => {
    setPending((current) =>
      new Map(current).set(pendingKey(request.integration, request.key), request.value),
    )
    mutation.start(request)
  }

  /** Положение выключателя: ожидаемое, пока идёт запрос, иначе — с сервера. */
  const positionOf = (integration: IntegrationView, key: SwitchKey): boolean => {
    const waiting = pending.get(pendingKey(integration, key))
    return waiting ?? integration.switches[key] === true
  }
  const isPending = (integration: IntegrationView, key: SwitchKey): boolean =>
    pending.has(pendingKey(integration, key))

  return { toggle, positionOf, isPending }
}
