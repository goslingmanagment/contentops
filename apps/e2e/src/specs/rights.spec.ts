import { randomUUID } from 'node:crypto'
import { type APIRequestContext, type Locator, type Page, request } from '@playwright/test'
import { E2E } from '../env.ts'
import { apiAs, expect, mskToday, statePath, test, type Who } from '../fixtures.ts'

/**
 * Rights by role in the browser (SPEC §11.1, DESIGN §2.3, §3.10; PLAN 4а–4в «Права на
 * операции…», stage 4 «Остальные роли получают только предусмотренные SPEC операции и
 * данные»). «Только чтение» sees Библиотеку, План and Журнал of its model without uploads,
 * downloads or any action, and the server refuses its commands; a content manager of another
 * model gets «Нет доступа к этой модели» everywhere under `/lora`, never Лора's data; the
 * content manager of Лора works there but owner-only settings are closed to her. «Промо» and
 * «Заказы» (4б, 4в) are read the same way: handoffs and orders without any action, an order
 * without its buyer and texts. Nothing here changes data except one order Диана opens for
 * the reader to look at.
 */

const PPV = 'PPV-073'
const PPV_TITLE = 'Вечеринка, блёстки, диван'

/** Buttons of actions and downloads that only the owner and managers get (DESIGN §2.3). */
const ACTIONS = [
  'Загрузить',
  'В план',
  'Скачать',
  'Скачать всё за день',
  'Скачать для заливки',
  'Отметить и подтвердить',
  'Подтвердить',
  'Настроить',
  'Подготовить передачу',
  'Подготовить заново',
  'Новая передача',
  'Скачать ZIP',
  'Передано',
  'Собрать заново',
  'Сделать PPV',
  'Новый заказ',
  'Добавить правку',
  'Привязать сдачу…',
  'Закрыть заказ',
  'Снять…',
]

async function expectNoActions(scope: Locator) {
  for (const name of ACTIONS) {
    await expect(scope.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(scope.getByRole('button', { name: /^Отметить/ })).toHaveCount(0)
}

const main = (page: Page) => page.getByRole('main', { name: 'Рабочее поле' })
const forbidden = (page: Page, text = 'Нет доступа к этой модели') =>
  expect(main(page).getByText(text)).toBeVisible()

/** A command of one person straight to the API, as the screen would send it. */
async function commandAs(
  who: Who,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  version?: number,
): Promise<{ status: number; code: string | undefined }> {
  const context: APIRequestContext = await request.newContext({
    baseURL: E2E.baseUrl,
    storageState: statePath(who),
  })
  try {
    const response = await context.fetch(path, {
      method,
      headers: {
        'idempotency-key': randomUUID(),
        ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
      },
      data: body,
    })
    const answer = (await response.json().catch(() => ({}))) as { code?: string }
    return { status: response.status(), code: answer.code }
  } finally {
    await context.dispose()
  }
}

async function statusOf(who: Who, path: string): Promise<number> {
  const context = await request.newContext({ baseURL: E2E.baseUrl, storageState: statePath(who) })
  try {
    return (await context.get(path)).status()
  } finally {
    await context.dispose()
  }
}

test.describe('«Только чтение» на Лоре', () => {
  test('sees Библиотеку, План and Журнал without uploads, downloads or actions', async ({
    reader,
  }) => {
    // The sidebar: three sections, no «Приехало» and no «Загрузить».
    await reader.goto('/lora/library')
    await expect(main(reader).getByRole('heading', { name: /^Библиотека/ })).toBeVisible()
    const nav = reader.getByRole('navigation', { name: 'Разделы' })
    await expect(nav.getByRole('link')).toHaveText([/^Библиотека/, /^План/, /^Журнал/])
    await expectNoActions(reader.locator('body'))

    // A section: tiles, filters, and the tile menu without work items.
    await main(reader).getByRole('link', { name: /^PPV/ }).click()
    await expect(reader).toHaveURL(/\/lora\/library\/ppv$/)
    const tiles = main(reader).getByRole('listbox', { name: 'PPV' })
    await expect(tiles.getByRole('option').first()).toBeVisible()
    await tiles.getByRole('option').first().click({ button: 'right' })
    const tileMenu = reader.getByRole('menu')
    await expect(tileMenu).toBeVisible()
    await expect(tileMenu.getByRole('menuitem', { name: 'Открыть' })).toBeVisible()
    for (const name of [/^В план/, /^Скачать/, /^В промо/, /^Удалить/, /^Сменить тип/]) {
      await expect(tileMenu.getByRole('menuitem', { name })).toHaveCount(0)
    }
    await reader.keyboard.press('Escape')
    await expectNoActions(reader.locator('body'))

    // The card: «ⓘ» and «⋯» only, markup and flags read-only.
    await reader.goto(`/lora/i/${PPV}`)
    await expect(main(reader).getByRole('heading', { name: PPV_TITLE, level: 1 })).toBeVisible()
    await expectNoActions(main(reader))
    await expect(main(reader).getByRole('button', { name: 'Название', exact: true })).toBeDisabled()
    await expect(
      main(reader).getByRole('switch', { name: 'Второй человек в кадре' }),
    ).toBeDisabled()
    await main(reader).getByRole('button', { name: 'Действия объекта' }).click()
    await expect(reader.getByRole('menuitem')).toHaveText([
      'Скопировать ID',
      /^Показать на Я\.Диске/,
      'Журнал объекта',
    ])
    await reader.keyboard.press('Escape')

    // The journal reads.
    await reader.goto('/lora/journal')
    await expect(main(reader).getByRole('heading', { name: /^Журнал/ })).toBeVisible()
    await expect(
      main(reader).getByRole('listbox', { name: 'События журнала' }).getByRole('option').first(),
    ).toBeVisible()
  })

  test('sees the day and the week of the plan without marks, downloads or new rows', async ({
    reader,
  }) => {
    await reader.goto(`/lora/plan/${mskToday()}`)
    const rows = main(reader).getByRole('listbox', { name: 'Строки дня' })
    await expect(rows.getByRole('option').first()).toBeVisible()
    await expectNoActions(main(reader))

    // The week: the norm's empty places do not add rows for the reader.
    await main(reader).getByRole('link', { name: 'Неделя' }).click()
    await expect(reader).toHaveURL(/\/lora\/plan\/w\/\d{4}-W\d{2}$/)
    const gaps = main(reader).getByRole('button', { name: /^\+ / })
    await expect(gaps.first()).toBeVisible()
    for (const gap of await gaps.all()) await expect(gap).toBeDisabled()
    await expectNoActions(main(reader))
  })

  test('the details of a plan row offer the reader no downloads', async ({ reader }) => {
    await reader.goto(`/lora/plan/${mskToday()}`)
    const rows = main(reader).getByRole('listbox', { name: 'Строки дня' })
    await rows.getByRole('option').first().click()
    await main(reader).getByRole('button', { name: 'Сведения', exact: true }).click()
    const details = main(reader).getByRole('complementary', { name: 'Сведения' })
    await expect(details.getByRole('heading', { level: 2 })).toBeVisible()
    await expectNoActions(details)
    await expect(details.getByRole('button', { name: /^Скачать/ })).toHaveCount(0)
    await expect(details.getByRole('button', { name: 'Другие варианты скачивания' })).toHaveCount(0)
  })

  test('«Приехало» is closed to the reader even by its address', async ({ reader }) => {
    await reader.goto('/lora/inbox')
    await forbidden(reader, 'Нет доступа к этому разделу')
    await expect(main(reader).getByRole('button', { name: 'Принять' })).toHaveCount(0)
    await expect(main(reader).getByRole('button', { name: 'Скачать исходник' })).toHaveCount(0)
  })

  test('sees Промо, a collection and its handoff without preparing, downloading or «Передано»', async ({
    reader,
  }) => {
    await reader.goto('/lora/library/promo')
    await expect(main(reader).getByRole('heading', { name: /^Промо/ })).toBeVisible()
    await expect(main(reader).getByRole('link', { name: 'Гиф-сайты' })).toBeVisible()
    await expectNoActions(main(reader))

    // The seed's collection PRM-005 with a handoff to Coraline Red already sent.
    await reader.goto('/lora/library/promo/gif-sites/PRM-005')
    await expect(main(reader).getByRole('heading', { name: /^Гифки, сентябрь/ })).toBeVisible()
    await expectNoActions(main(reader))

    await reader.goto('/lora/library/promo?view=handoffs')
    const row = main(reader).getByRole('option').filter({ hasText: 'Coraline Red' })
    await expect(row).toContainText('передано')
    await row.getByRole('button', { name: /^PRM-005/ }).click()
    const panel = main(reader).getByRole('complementary', { name: 'Передача PRM-005' })
    await expect(panel.getByRole('heading', { name: 'Сводка для Telegram' })).toBeVisible()
    await expectNoActions(panel)
  })

  test('sees an order without its buyer, texts or any action', async ({ reader }) => {
    const run = Date.now() % 1_000_000_000
    const km = await apiAs('km')
    const order = await km.post<{ id: string }>('/api/v1/lora/orders', {
      message_url: `https://t.me/c/2627984998/12/${run}`,
      card_text: `📌 Кастом «чтение ${run}»`,
      buyer: `фан №${run}`,
      account: 'lora-2',
      brief: `чтение ${run}`,
      duration_raw: '3-5 минут',
      wants_video: true,
      wants_photos: 0,
      deadline: null,
      fan_name: 'no',
    })
    await km.context.dispose()

    await reader.goto('/lora/library/customs?view=orders')
    const list = main(reader).getByRole('listbox', { name: 'Заказы' })
    await expect(list.getByRole('option', { name: new RegExp(`чтение ${run}`) })).toBeVisible()
    await expectNoActions(main(reader))
    await expect(main(reader).getByText(`фан №${run}`)).toHaveCount(0)

    await reader.goto(`/lora/library/customs/orders/${order.id}`)
    const panel = main(reader).getByRole('complementary', { name: 'Заказ' })
    await expect(panel.getByRole('heading', { name: `Кастом «чтение ${run}»` })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Части' })).toBeVisible()
    await expectNoActions(panel)
    // Nothing to offer the reader: no «Ещё» with an empty menu.
    await expect(panel.getByRole('button', { name: 'Ещё' })).toHaveCount(0)
    await expect(reader.getByText(`фан №${run}`)).toHaveCount(0)
    await expect(reader.getByText('📌 Кастом')).toHaveCount(0)

    // The server refuses the reader's order commands, and the order itself stays open.
    for (const [path, body] of [
      [`/api/v1/lora/orders/${order.id}/revisions`, { text: 'чужая правка', message_url: null }],
      [`/api/v1/lora/orders/${order.id}:cancel`, { reason: 'чужое решение' }],
      [`/api/v1/lora/orders/${order.id}:close`, {}],
    ] as const) {
      expect(await commandAs('reader', 'POST', path, body)).toEqual({
        status: 403,
        code: 'forbidden',
      })
    }
    const create = await commandAs('reader', 'POST', '/api/v1/lora/orders', {
      message_url: `https://t.me/c/2627984998/12/${run + 1}`,
      brief: 'чужой заказ',
    })
    expect(create).toEqual({ status: 403, code: 'forbidden' })
  })

  test('the server refuses the reader’s promo commands: add, prepare, «Передано»', async () => {
    const add = await commandAs('reader', 'POST', '/api/v1/lora/promo/collections:add', {
      channel: 'reddit',
      collection: 'new',
      title: null,
      members: [{ item_id: 'PPV-073', file_key: 'teaser' }],
    })
    expect(add).toEqual({ status: 403, code: 'forbidden' })
    const prepare = await commandAs(
      'reader',
      'POST',
      '/api/v1/lora/promo/collections/PRM-005/handoffs',
      { contractor_id: 'none', strip_metadata: true, exclude_already_handed: false, members: null },
    )
    expect(prepare).toEqual({ status: 403, code: 'forbidden' })
    const reader = await apiAs('reader')
    const handoffs = await reader.get<{ items: { id: string; collection_id: string }[] }>(
      '/api/v1/lora/promo/handoffs',
    )
    await reader.context.dispose()
    const sent = handoffs.items.find((item) => item.collection_id === 'PRM-005')
    expect(sent).toBeDefined()
    const mark = await commandAs(
      'reader',
      'POST',
      `/api/v1/lora/promo/collections/PRM-005/handoffs/${sent?.id}:mark-sent`,
      {},
    )
    expect(mark).toEqual({ status: 403, code: 'forbidden' })
  })

  test('the server refuses the reader’s commands: download, markup, plan', async () => {
    const download = await commandAs('reader', 'POST', `/api/v1/lora/i/${PPV}/downloads`, {
      kind: 'master',
      strip_metadata: false,
      account: null,
    })
    expect(download).toEqual({ status: 403, code: 'forbidden' })
    const field = await commandAs(
      'reader',
      'PATCH',
      `/api/v1/lora/i/${PPV}/fields/title`,
      { key: 'title', value: 'Чужая правка' },
      1,
    )
    expect(field).toEqual({ status: 403, code: 'forbidden' })
    const plan = await commandAs('reader', 'POST', '/api/v1/lora/plan/rows', {
      rows: [
        {
          item_id: PPV,
          account: 'lora-1',
          surface: 'wall',
          date: mskToday(),
          time: null,
          fyp_version: null,
          assignee: null,
          note: null,
          requires_new_upload: false,
          awaiting_montage: null,
          marked: null,
        },
      ],
    })
    expect(plan).toEqual({ status: 403, code: 'forbidden' })
    const day = await commandAs('reader', 'POST', '/api/v1/lora/plan/downloads', {
      scope: 'day',
      date: mskToday(),
      week: null,
      release_id: null,
      account: 'lora-1',
      strip_metadata: false,
    })
    expect(day).toEqual({ status: 403, code: 'forbidden' })
  })
})

test.describe('Контент-менеджер Ари', () => {
  test('gets «Нет доступа к этой модели» everywhere under Лора, his own model works', async ({
    stranger,
  }) => {
    for (const path of [
      '/lora/library',
      '/lora/library/ppv',
      `/lora/i/${PPV}`,
      '/lora/plan',
      `/lora/plan/${mskToday()}`,
      '/lora/journal',
      '/lora/inbox',
      '/lora/library/promo',
      '/lora/library/promo/gif-sites/PRM-005',
      '/lora/library/customs?view=orders',
    ]) {
      await stranger.goto(path)
      await forbidden(stranger)
      await expect(stranger.getByText(PPV_TITLE)).toHaveCount(0)
      await expect(stranger.getByText(PPV)).toHaveCount(0)
    }
    // Лора is not among his models; the sidebar is Ари's.
    await expect(stranger.getByRole('complementary', { name: 'Колонка' })).toContainText('Ари')
    await expect(stranger.getByRole('complementary', { name: 'Колонка' })).not.toContainText('Лора')

    await stranger.goto('/ari/library')
    await expect(main(stranger).getByRole('heading', { name: /^Библиотека\s*Ари/ })).toBeVisible()

    // The server answers 403 whether the object exists or not (SPEC §11.2), never 404.
    expect(await statusOf('stranger', `/api/v1/lora/i/${PPV}`)).toBe(403)
    expect(await statusOf('stranger', '/api/v1/lora/i/PPV-999')).toBe(403)
    expect(await statusOf('stranger', '/api/v1/lora/index')).toBe(403)
    expect(await statusOf('stranger', '/api/v1/lora/orders')).toBe(403)
    expect(await statusOf('stranger', '/api/v1/lora/promo/handoffs')).toBe(403)
    const download = await commandAs('stranger', 'POST', `/api/v1/lora/i/${PPV}/downloads`, {
      kind: 'master',
      strip_metadata: false,
      account: null,
    })
    expect(download).toEqual({ status: 403, code: 'forbidden' })
  })
})

test.describe('Контент-менеджер Лоры', () => {
  test('works in Библиотеке and Плане, owner-only settings are closed', async ({ km }) => {
    await km.goto('/lora/library')
    await expect(main(km).getByRole('heading', { name: /^Библиотека/ })).toBeVisible()
    await expect(km.getByRole('button', { name: 'Загрузить', exact: true })).toBeVisible()
    const nav = km.getByRole('navigation', { name: 'Разделы' })
    await expect(nav.getByRole('link', { name: /^Приехало/ })).toBeVisible()

    await km.goto(`/lora/plan/${mskToday()}`)
    await expect(main(km).getByRole('listbox', { name: 'Строки дня' })).toBeVisible()
    await expect(main(km).getByRole('button', { name: 'В план', exact: true })).toBeVisible()

    await km.goto('/settings')
    const tabs = main(km).getByRole('navigation', { name: 'Разделы настроек' })
    await expect(tabs.getByRole('link')).toHaveText([
      'Страницы и нормы',
      'Интеграции',
      'Состояние',
      'Профиль и сессии',
    ])
    for (const tab of ['people', 'agents', 'thresholds', 'tags']) {
      await km.goto(`/settings/${tab}`)
      await forbidden(km, 'Нет доступа к этому разделу')
    }
    expect(await statusOf('km', '/api/v1/admin/people')).toBe(403)
    const person = await commandAs('km', 'POST', '/api/v1/admin/people', {
      name: 'Лишний',
      login: `extra-${Date.now().toString(36)}`,
      role: 'manager',
      models: ['lora'],
    })
    expect(person).toEqual({ status: 403, code: 'forbidden' })
  })
})
