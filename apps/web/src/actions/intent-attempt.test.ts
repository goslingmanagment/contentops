import { ApiError } from '@contentops/contracts'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ActionToastApi } from './action-toast-context'
import { type IntentCall, intentAttempt } from './intent-attempt'

/**
 * Хук useMutation — это наблюдатель TanStack, на которого подписан компонент. Подписка
 * здесь — «источник смонтирован», отписка — «окно закрыто» или «выделение снято».
 */
function mountedSource<Result>(
  client: QueryClient,
  run: (call: IntentCall<string>) => Promise<Result>,
) {
  const observer = new MutationObserver<Result, unknown, IntentCall<string>>(client, {
    mutationFn: run,
  })
  const unmount = observer.subscribe(() => {})
  return { execute: observer.mutate, unmount }
}

function fakeToast() {
  return { showFailure: vi.fn<ActionToastApi['showFailure']>() }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('intentAttempt', () => {
  it('отмена после размонтирования источника сбрасывает кэш и показывает итог', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    const toast = fakeToast()
    const shown: string[] = []
    const calls: IntentCall<string>[] = []
    const source = mountedSource(client, async (call) => {
      calls.push(call)
      return `ok:${call.variables}`
    })
    const undo = intentAttempt({
      execute: source.execute,
      queryClient: client,
      toast,
      failed: 'Не удалилось',
      invalidates: (row) => [['plan', row]],
      onSuccess: (result) => shown.push(result),
    })

    // «Поставить» закрыло окно — источник ушёл до нажатия «Отменить» в полоске.
    source.unmount()
    undo('ROW-1', 'key-1')
    await settled()

    expect(calls).toEqual([{ variables: 'ROW-1', key: 'key-1' }])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plan', 'ROW-1'] })
    expect(shown).toEqual(['ok:ROW-1'])
    expect(toast.showFailure).not.toHaveBeenCalled()
  })

  it('ответ, пришедший после размонтирования, не теряется', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    let answer: (value: string) => void = () => {}
    const source = mountedSource(
      client,
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
    )
    const onSuccess = vi.fn()
    const mark = intentAttempt({
      execute: source.execute,
      queryClient: client,
      toast: fakeToast(),
      failed: 'Не отметилось',
      invalidates: () => [['index']],
      onSuccess,
    })

    mark('ROW-2', 'key-2')
    await settled()
    source.unmount()
    answer('done')
    await settled()

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['index'] })
    expect(onSuccess).toHaveBeenCalledWith('done', 'ROW-2')
  })

  it('ошибка после размонтирования даёт полоску, а «Повторить» идёт с прежним ключом', async () => {
    const client = new QueryClient()
    const toast = fakeToast()
    const keys: string[] = []
    let fail = true
    const source = mountedSource(client, async (call) => {
      keys.push(call.key)
      if (fail) {
        throw new TypeError('Failed to fetch')
      }
      return 'ok'
    })
    const onSuccess = vi.fn()
    const attempt = intentAttempt({
      execute: source.execute,
      queryClient: client,
      toast,
      failed: 'Не вернулось',
      onSuccess,
    })

    source.unmount()
    attempt('GRP-1', 'key-3')
    await settled()

    expect(toast.showFailure).toHaveBeenCalledTimes(1)
    const [error, options] = toast.showFailure.mock.calls[0] ?? []
    expect(error).toBeInstanceOf(TypeError)
    expect(options?.failed).toBe('Не вернулось')

    fail = false
    options?.retry?.()
    await settled()

    expect(keys).toEqual(['key-3', 'key-3'])
    expect(onSuccess).toHaveBeenCalledWith('ok', 'GRP-1')
  })

  it('отказ, показанный экраном, не уходит в полоску', async () => {
    const client = new QueryClient()
    const toast = fakeToast()
    const conflict = new ApiError(412, {
      code: 'version_mismatch',
      message: 'Запись уже изменили',
      request_id: 'req_1',
    })
    const source = mountedSource(client, async () => {
      throw conflict
    })
    const handleFailure = vi.fn(() => true)
    intentAttempt({
      execute: source.execute,
      queryClient: client,
      toast,
      failed: 'Не сохранилось',
      handleFailure,
    })('NOTE', 'key-4')
    await settled()

    expect(handleFailure).toHaveBeenCalledWith(conflict, 'NOTE')
    expect(toast.showFailure).not.toHaveBeenCalled()
  })
})
