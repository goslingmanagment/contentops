import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import type { DownloadKind } from '../../commands/objects'
import { downloadFileName } from '../../download-files'
import { EXPORT_NAME_PATTERN } from '../../download-name'
import { createApiClient } from '../client'
import { createMockFetch } from './mock-fetch'

/** Что и под какими именами отдаёт «Скачать» (DESIGN §4.4–4.5, naming §3–6). */

const lora = { model: 'lora' }

function setup() {
  const mock = createMockFetch({
    latency: false,
    clock: createFrozenClock(PROTOTYPE_NOW),
    operation_ms: 0,
  })
  return { api: createApiClient(mock), mock }
}

type Setup = ReturnType<typeof setup>

async function sample({ mock }: Setup, url: string): Promise<string> {
  return (await mock(url, { method: 'GET' })).text()
}

/** Строки архива из образца: «  3. SET-074_…_ed03.jpg — кадр 3 · обработанный». */
function members(text: string): string[] {
  return [...text.matchAll(/^ {2}\d+\. (.+)$/gm)].map((match) => match[1] ?? '')
}

interface Issued {
  file_name: string
  download_url: string
  size_bytes: number | null
}

async function download(
  env: Setup,
  id: string,
  kind: DownloadKind,
  planRow: string | null = null,
): Promise<Issued> {
  const answer = await env.api.objects.download({
    params: { ...lora, id },
    body: { kind, strip_metadata: true, account: null, plan_row: planRow },
  })
  if (answer.kind === 'ready') return answer
  const operation = await env.api.operations.get({
    params: { ...lora, operation: answer.operation_id },
  })
  const result = operation.result
  if (!result?.download_url || !result.file_name) throw new Error('копия не собралась')
  return {
    file_name: result.file_name,
    download_url: result.download_url,
    size_bytes: result.size_bytes,
  }
}

describe('имена выдачи объекта', () => {
  it('английское название проходит через карточку, подсказку и выдачу файла', async () => {
    const env = setup()
    const record = env.mock.state.world.models.get('lora')?.items.get('PPV-073')
    if (!record) throw new Error('нет PPV-073')
    record.entry.title_en = 'Birthday cake lace'

    const detail = await env.api.objects.get({ params: { ...lora, id: 'PPV-073' } })
    expect(detail.entry.title_en).toBe('Birthday cake lace')
    const answer = await download(env, 'PPV-073', 'master')
    expect(answer.file_name).toBe('PPV-073_birthday-cake-lace_master_v2__13m24s.mp4')
    expect(downloadFileName(detail.entry, detail.files, 'master')).toBe(answer.file_name)
  })

  it('английское название одинаково используется для ZIP и его файлов', async () => {
    const env = setup()
    const record = env.mock.state.world.models.get('lora')?.items.get('SET-074')
    if (!record) throw new Error('нет SET-074')
    record.entry.title_en = 'Reading a Book'

    const day = await env.api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const row = day.rows.find(
      (candidate) => candidate.manifest?.item_id === 'SET-074' && candidate.account === 'lora-2',
    )
    if (!row) throw new Error('нет строки плана SET-074')
    const answer = await download(env, 'SET-074', 'platform', row.id)
    expect(answer.file_name).toBe('SET-074_reading-book_ed__lora-2_2026-09-22_2000.zip')
    expect(members(await sample(env, answer.download_url))[0]).toBe(
      'SET-074_reading-book_ed01__lora-2_2026-09-22_2000.jpg — кадр 1 · обработанный',
    )
  })

  it('мастер PPV-073 — версия `_v2` и длительность текущей версии', async () => {
    const answer = await download(setup(), 'PPV-073', 'master')
    expect(answer.file_name).toBe('PPV-073_den-rozhdeniya-tort-kruzhevo_master_v2__13m24s.mp4')
    expect(answer.file_name).toMatch(EXPORT_NAME_PATTERN)
  })

  it('фото 100 % сета — все кадры по съёмке, роль `raw`', async () => {
    const env = setup()
    const answer = await download(env, 'SET-074', 'photos')
    expect(answer.file_name).toBe('SET-074_chtenie-knigi-stringi_raw.zip')
    const listed = members(await sample(env, answer.download_url))
    expect(listed).toHaveLength(46)
    expect(listed[0]).toBe('SET-074_chtenie-knigi-stringi_raw01.jpg')
  })

  it('фуп без строки плана — базовый монтаж без `_uN`', async () => {
    const answer = await download(setup(), 'FYP-0801', 'platform')
    expect(answer.file_name).toBe('FYP-0801_zerkalo-chernoe-bodi_master.mp4')
  })
})

describe('«Для заливки» у сета (DESIGN §4.4, §4.5)', () => {
  it('отобранные 21 кадр по порядку, `ed01…`, обработанные вместо исходных', async () => {
    const env = setup()
    const answer = await download(env, 'SET-074', 'platform')
    expect(answer.file_name).toBe('SET-074_chtenie-knigi-stringi_ed.zip')
    const listed = members(await sample(env, answer.download_url))
    expect(listed).toHaveLength(21)
    expect(listed[0]).toBe('SET-074_chtenie-knigi-stringi_ed01.jpg — кадр 1 · обработанный')
    expect(listed[20]).toBe('SET-074_chtenie-knigi-stringi_ed21.jpg — кадр 21 · исходный')
    expect(listed.filter((line) => line.endsWith('обработанный'))).toHaveLength(8)
    expect(answer.size_bytes).toBe(21 * 2_400_000)
  })

  it('строка плана с сетом — те же 21 кадр, в именах страница, день и время', async () => {
    const env = setup()
    const day = await env.api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const row = day.rows.find(
      (candidate) => candidate.manifest?.item_id === 'SET-074' && candidate.account === 'lora-2',
    )
    expect(row?.manifest?.files).toEqual([
      {
        key: 'platform',
        label: 'Фото 21 шт., по порядку',
        download_name: 'SET-074_chtenie-knigi-stringi_ed__lora-2_2026-09-22_2000.zip',
      },
    ])
    expect(row?.copy).toMatchObject({ state: 'ready', size_bytes: 21 * 2_400_000 })
    if (!row) return
    const answer = await download(env, 'SET-074', 'platform', row.id)
    const listed = members(await sample(env, answer.download_url))
    expect(listed[0]).toBe(
      'SET-074_chtenie-knigi-stringi_ed01__lora-2_2026-09-22_2000.jpg — кадр 1 · обработанный',
    )
  })
})

describe('«Для заливки» из строки плана у фупа (naming §3, §6)', () => {
  it('версия строки — `_u1` на Fansly 2 и `_u2` на Fansly 3', async () => {
    const env = setup()
    const day = await env.api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const rowOf = (account: string) =>
      day.rows.find((row) => row.manifest?.item_id === 'FYP-0801' && row.account === account)
    const names = await Promise.all(
      ['lora-2', 'lora-3'].map(async (account) => {
        const row = rowOf(account)
        return row ? (await download(env, 'FYP-0801', 'platform', row.id)).file_name : null
      }),
    )
    expect(names).toEqual([
      'FYP-0801_zerkalo-chernoe-bodi_master_u1__lora-2_2026-09-22_0300.mp4',
      'FYP-0801_zerkalo-chernoe-bodi_master_u2__lora-3_2026-09-22_0300.mp4',
    ])
  })
})

describe('архивы плана и промо', () => {
  it('архив дня — кадры сета отдельными файлами в папке кода страницы', async () => {
    const env = setup()
    const accepted = await env.api.plan.download({
      params: lora,
      body: {
        scope: 'day',
        date: '2026-09-22',
        week: null,
        release_id: null,
        account: 'lora-1',
        strip_metadata: true,
      },
    })
    if (accepted.kind !== 'operation') throw new Error('архив собирается операцией')
    const operation = await env.api.operations.get({
      params: { ...lora, operation: accepted.operation_id },
    })
    const listed = members(await sample(env, operation.result?.download_url ?? ''))
    expect(listed).toContain(
      'lora-1/SET-074_chtenie-knigi-stringi_ed21__lora-1_2026-09-22_2000.jpg — кадр 21 · исходный',
    )
    for (const line of listed) {
      expect(line.split(' — ')[0]?.split('/')[1]).toMatch(EXPORT_NAME_PATTERN)
    }
  })

  it('ZIP передачи PRM-013 — `PRM-013_001_…` по порядку и `manifest.csv`', async () => {
    const env = setup()
    const handoffs = await env.api.promo.handoffs({ params: lora, query: {} })
    const handoff = handoffs.items.find((candidate) => candidate.collection_id === 'PRM-013')
    expect(handoff?.zip_url).toBeTruthy()
    const text = await sample(env, handoff?.zip_url ?? '')
    const listed = members(text)
    expect(listed).toHaveLength(331)
    expect(listed[0]).toMatch(/^PRM-013_001_(?:FYP-\d{4}|[A-Z]+-\d+-[a-z]+\d{2})\.(?:mp4|jpg)$/)
    expect(listed.at(-1)).toBe('manifest.csv')
    expect(text).toContain('prm,order,file_name,source_id,role,version,master_sha256')
  })
})
