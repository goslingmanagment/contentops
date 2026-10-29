import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import { downloadFileName } from '../../download-files'
import { createApiClient } from '../client'
import { createMockFetch } from './mock-fetch'

const lora = { model: 'lora' }

function setup() {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW), operation_ms: 0 }),
  )
}

describe('страница объекта', () => {
  it('история PPV-073 — от приёмки 07.08 до подборки промо, новые сверху', async () => {
    const journal = await setup().journal.list({ params: lora, query: { item: 'PPV-073' } })
    const phrases = journal.items.map((event) => event.phrase)
    expect(phrases.at(-1)).toBe('Агент приёмки принял PPV-073 из «1. PPV/07.08.26»')
    expect(phrases).toContain('Диана загрузила перемонтаж PPV-073 — мастер v2')
    const times = journal.items.map((event) => event.at)
    expect([...times].sort().reverse()).toEqual(times)
  })

  it('имя выданного файла совпадает с квитанцией, а подсказка «будущее имя» — с выдачей', async () => {
    const api = setup()
    const answer = await api.objects.download({
      params: { ...lora, id: 'FYP-0801' },
      body: { kind: 'platform', strip_metadata: true, account: null },
    })
    const detail = await api.objects.get({ params: { ...lora, id: 'FYP-0801' } })
    expect(answer.kind).toBe('ready')
    if (answer.kind !== 'ready') return
    expect(answer.file_name).toBe(
      downloadFileName(detail.entry, detail.files, 'platform', { model: 'lora' }),
    )
    expect(detail.receipts[0]?.file_name).toBe(answer.file_name)
  })
})
