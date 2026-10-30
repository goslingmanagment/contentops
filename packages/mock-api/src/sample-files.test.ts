import { createApiClient } from '@contentops/contracts/api/client'
import { createFrozenClock } from '@contentops/contracts/clock'
import { describe, expect, it } from 'vitest'
import { createMockFetch } from './mock-fetch'
import { PROTOTYPE_NOW } from './prototype-clock'

function setup() {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
  })
  return { api: createApiClient(mock), mock }
}

const lora = { model: 'lora' }

async function sampleOf(mock: ReturnType<typeof setup>['mock'], url: string) {
  const response = await mock(url, { method: 'GET' })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('text/plain')
  return response.text()
}

describe('образцы файлов прототипа', () => {
  it('по ссылке «Скачать» объекта лежит записка с именем, видом, источником и метаданными', async () => {
    const { api, mock } = setup()
    const answer = await api.objects.download({
      params: { ...lora, id: 'PPV-073' },
      body: { kind: 'master', strip_metadata: true, account: 'lora-2' },
    })
    expect(answer.kind).toBe('ready')
    if (answer.kind !== 'ready') return
    const text = await sampleOf(mock, answer.download_url)
    expect(text).toContain('Образец ContentOps')
    expect(text).toContain(`Имя: ${answer.file_name}`)
    expect(text).toContain('Вид копии: Мастер')
    expect(text).toContain('Fansly 2')
    expect(text).toContain('Источник: PPV-073')
    expect(text).toContain('Метаданные стёрты: да')
  })

  it('у архива дня — файлы по кодам страниц, кадры отдельными файлами', async () => {
    const { api, mock } = setup()
    const accepted = await api.plan.download({
      params: lora,
      body: {
        scope: 'day',
        date: '2026-09-22',
        week: null,
        release_id: null,
        account: null,
        strip_metadata: false,
      },
    })
    expect(accepted.kind).toBe('operation')
    if (accepted.kind !== 'operation') return
    const operation = await api.operations.get({
      params: { ...lora, operation: accepted.operation_id },
    })
    const url = operation.result?.download_url
    expect(url).toBeTruthy()
    if (!url) return
    const text = await sampleOf(mock, url)
    expect(text).toContain('Архив дня')
    expect(text).toContain('Метаданные стёрты: нет')
    expect(text).toMatch(/В архиве \d+ файл/)
    expect(text).toMatch(/1\. lora-[a-z0-9-]+\/[A-Z]+-\d+_/)
  })

  it('незнакомый адрес — не образец, а обычная ошибка API', async () => {
    const { mock } = setup()
    const response = await mock('/api/v1/lora/downloads/nothing.zip', { method: 'GET' })
    expect(response.status).toBe(404)
  })
})
