import type { Locator, Page } from '@playwright/test'
import { apiAs, expect, test } from '../fixtures.ts'

/**
 * SPEC §12.0 «Внешний вид и поведение интерфейса», DESIGN §3.13 п. 3–5 — PLAN, закрытие
 * этапа 4: «Сохранение контекста, выделения и несохранённых правок проверено сквозными
 * тестами по SPEC §12.0». Правки — только PPV-083, PPV-084, PPV-085 (другие сценарии их не
 * трогают); выделение и прокрутка — где угодно в Библиотеке.
 */

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

interface MarkupDetail {
  markup: { field: { key: string; value: unknown }; version: number }[]
}

/** Поле разметки объекта, как его видит сервер сейчас: значение и версия. */
async function serverField(id: string, key: string) {
  const owner = await apiAs('owner')
  const detail = await owner.get<MarkupDetail>(`/api/v1/lora/i/${id}`)
  await owner.context.dispose()
  const field = detail.markup.find((entry) => entry.field.key === key)
  return { value: field?.field.value, version: field?.version }
}

/** Другой человек меняет поле разметки, пока открыта карточка (`If-Match` его версии). */
async function changeAsKm(id: string, key: 'title' | 'description', value: string) {
  const km = await apiAs('km')
  const detail = await km.get<MarkupDetail>(`/api/v1/lora/i/${id}`)
  const field = detail.markup.find((entry) => entry.field.key === key)
  await km.send('PATCH', `/api/v1/lora/i/${id}/fields/${key}`, { key, value }, field?.version)
  await km.context.dispose()
}

/**
 * Фоновое обновление карточки, как в жизни: данные устарели (30 с) и сеть вернулась —
 * карточка перечитывается сама, без действия человека. Часы страницы перематываются.
 */
async function refreshInBackground(page: Page, id: string) {
  const refetched = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/v1/lora/i/${id}`,
  )
  await page.clock.fastForward('00:31')
  await page.context().setOffline(true)
  await page.context().setOffline(false)
  await refetched
}

/** Плитки, которые сейчас видны в прокручиваемой сетке (виртуальная сетка рисует запас). */
async function visibleEntryIds(grid: Locator): Promise<string[]> {
  return grid.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return [...element.querySelectorAll('[data-entry-id]')]
      .filter((node) => {
        const rect = node.getBoundingClientRect()
        return rect.top >= box.top && rect.bottom <= box.bottom
      })
      .map((node) => node.getAttribute('data-entry-id') as string)
  })
}

test('return from a card restores filters, selection and scroll of the section', async ({
  owner: page,
}) => {
  await page.goto('/lora/library/ppv')
  const grid = page.getByRole('listbox', { name: 'PPV' })
  const filters = page.getByRole('toolbar', { name: 'Фильтры' })
  await expect(grid.getByRole('option').first()).toBeVisible()

  // Фильтр — в адресе.
  await filters.getByRole('button', { name: 'Бандл' }).click()
  await expect(page).toHaveURL(/\/lora\/library\/ppv\?kind=bundle$/)
  await expect(filters.getByRole('button', { name: 'Бандл' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Прокрутка и выделение — в записи истории.
  await grid.evaluate((element) => element.scrollTo(0, 400))
  const visible = await visibleEntryIds(grid)
  expect(visible.length).toBeGreaterThanOrEqual(3)
  const [first, , third] = visible as [string, string, string]
  await grid.locator(`[data-entry-id="${first}"]`).click()
  await grid.locator(`[data-entry-id="${third}"]`).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByRole('toolbar', { name: 'Выбрано: 2' })).toBeVisible()
  await page.waitForFunction(() => typeof window.history.state?.['library:ppv:scroll'] === 'number')
  const scrolled = await grid.evaluate((element) => element.scrollTop)
  expect(scrolled).toBeGreaterThan(200)

  // `Enter` открывает объект под фокусом, не трогая выделение.
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/lora/i/${third}$`))
  await expect(page.getByRole('button', { name: third, exact: true })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/lora\/library\/ppv\?kind=bundle$/)
  await expect(filters.getByRole('button', { name: 'Бандл' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('toolbar', { name: 'Выбрано: 2' })).toBeVisible()
  await expect(grid.locator('[role=option][aria-selected=true] [data-entry-id]')).toHaveCount(2)
  for (const id of [first, third]) {
    await expect(
      grid.getByRole('option').filter({ has: page.locator(`[data-entry-id="${id}"]`) }),
    ).toHaveAttribute('aria-selected', 'true')
  }
  await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBe(scrolled)
})

test('a background refresh of the card keeps what is being typed', async ({ owner: page }) => {
  const id = 'PPV-084'
  await page.clock.install()
  await page.goto(`/lora/i/${id}`)
  const description = page.getByRole('textbox', { name: 'Описание' })
  const draft = `Танцует у окна, потом садится на диван — черновик ${stamp()}`
  await description.fill(draft)
  await expect(description).toBeFocused()

  // Диана меняет название того же объекта; карточка перечитывается в фоне.
  const title = `Джинсовые шорты, отель, сквирт ${stamp()}`
  await changeAsKm(id, 'title', title)
  await refreshInBackground(page, id)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)

  // Ввод не сброшен и фокус на месте; сохраняется, когда поле теряет фокус.
  await expect(description).toHaveValue(draft)
  await expect(description).toBeFocused()
  await description.blur()
  await expect(page.getByText('Сохранено', { exact: true })).toBeVisible()
  await expect.poll(async () => (await serverField(id, 'description')).value).toBe(draft)
})

test('a background refresh with the same field changed by another person keeps the draft and shows the conflict', async ({
  owner: page,
}) => {
  const id = 'PPV-083'
  await page.clock.install()
  await page.goto(`/lora/i/${id}`)
  const description = page.getByRole('textbox', { name: 'Описание' })
  const mine = `Мой черновик описания ${stamp()}`
  await description.fill(mine)

  const theirs = `Описание Дианы ${stamp()}`
  await changeAsKm(id, 'description', theirs)
  await refreshInBackground(page, id)

  // SPEC §12.0: фон не сбрасывает ввод; конфликт с новой версией — явно.
  await expect(description).toHaveValue(mine)
  await description.blur()
  const conflict = page.getByRole('alert').filter({ hasText: 'Диана изменила описание' })
  await expect(conflict).toBeVisible()
  await expect.poll(async () => (await serverField(id, 'description')).value).toBe(theirs)
})

test('a concurrent edit gets 412 shown as a conflict with who changed it; «Оставить мой» saves it', async ({
  owner: page,
  km,
}) => {
  const id = 'PPV-085'
  await page.goto(`/lora/i/${id}`)
  await km.goto(`/lora/i/${id}`)
  const mineField = page.getByRole('textbox', { name: 'Описание' })
  const theirsField = km.getByRole('textbox', { name: 'Описание' })
  await expect(mineField).toBeVisible()
  await expect(theirsField).toBeVisible()

  // Диана сохраняет первой.
  const theirs = `Боди в сеточку на балконе — версия Дианы ${stamp()}`
  await theirsField.fill(theirs)
  await theirsField.blur()
  await expect(km.getByText('Сохранено', { exact: true })).toBeVisible()

  // Владелец сохраняет со старой версии: 412 встаёт строкой на месте поля.
  const mine = `Боди в сеточку на балконе — версия владельца ${stamp()}`
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/api/v1/lora/i/${id}/fields/description`),
  )
  await mineField.fill(mine)
  await mineField.blur()
  expect((await answered).status()).toBe(412)
  const conflict = page.getByRole('alert').filter({ hasText: 'Диана изменила описание' })
  await expect(conflict).toBeVisible()
  await expect(conflict.getByRole('button', { name: 'Показать её вариант' })).toBeVisible()
  await expect(page.getByText('Сохранено', { exact: true })).toHaveCount(0)
  // Молча ничего не перезаписано: на сервере вариант Дианы.
  expect((await serverField(id, 'description')).value).toBe(theirs)

  // «Оставить мой» отправляет введённое поверх новой версии — текст не потерян.
  await conflict.getByRole('button', { name: 'Оставить мой' }).click()
  await expect(page.getByText('Сохранено', { exact: true })).toBeVisible()
  await expect(conflict).toBeHidden()
  await expect(mineField).toHaveValue(mine)
  await expect.poll(async () => (await serverField(id, 'description')).value).toBe(mine)
})

/** Рамки плиток и мест под миниатюры, по порядку. */
function boxesOf(scope: Locator): Promise<number[][]> {
  return scope.evaluate((element) =>
    [...element.querySelectorAll('[data-slot="object-tile"], [data-slot="thumb"]')].map((node) => {
      const rect = node.getBoundingClientRect()
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10)
    }),
  )
}

/** Все миниатюры в области загружены и нарисованы. */
async function thumbnailsLoaded(scope: Locator): Promise<boolean> {
  return scope.evaluate((element) => {
    const images = [...element.querySelectorAll<HTMLImageElement>('[data-slot="thumb"] img')]
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
  })
}

test('media places are reserved: thumbnails arriving do not move the grid or the card', async ({
  owner: page,
}) => {
  // Миниатюры держатся, пока места не измерены; сдвиги считаются только после выдачи.
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested = 0
  await page.route('**/api/v1/lora/g/**', async (route) => {
    requested += 1
    await held
    await route.continue()
  })
  await page.addInitScript(() => {
    const shifts: number[] = []
    Object.assign(window, { __shifts: shifts })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number
        hadRecentInput: boolean
      })[]) {
        if (!entry.hadRecentInput) shifts.push(entry.value)
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })
  const shiftsAfter = (from: number) =>
    page.evaluate(
      (count) => (window as unknown as { __shifts: number[] }).__shifts.slice(count),
      from,
    )
  const shiftCount = () =>
    page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts.length)

  // Сетка раздела.
  await page.goto('/lora/library/ppv')
  const grid = page.getByRole('listbox', { name: 'PPV' })
  await expect(grid.locator('[data-slot="thumb"] img').first()).toBeAttached()
  await expect.poll(() => requested).toBeGreaterThan(0)
  expect(await thumbnailsLoaded(grid)).toBe(false)
  const gridBefore = await boxesOf(grid)
  const gridShifts = await shiftCount()
  expect(gridBefore.length).toBeGreaterThan(4)

  release()
  await expect.poll(() => thumbnailsLoaded(grid)).toBe(true)
  expect(await boxesOf(grid)).toEqual(gridBefore)
  expect(await shiftsAfter(gridShifts)).toEqual([])

  // Файлы карточки: мастер, тизер, кадры, фото.
  let releaseCard: () => void = () => {}
  const heldCard = new Promise<void>((resolve) => {
    releaseCard = resolve
  })
  await page.unroute('**/api/v1/lora/g/**')
  await page.route('**/api/v1/lora/g/**', async (route) => {
    await heldCard
    await route.continue()
  })
  await page.goto('/lora/i/PPV-085')
  const files = page.getByRole('main')
  await expect(page.getByRole('listbox', { name: 'Мастер и тизер' })).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Кадры мастера' })).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Фото' })).toBeVisible()
  expect(await thumbnailsLoaded(files)).toBe(false)
  const cardBefore = await boxesOf(files)
  const cardShifts = await shiftCount()
  expect(cardBefore.length).toBeGreaterThan(4)

  releaseCard()
  await expect.poll(() => thumbnailsLoaded(files)).toBe(true)
  expect(await boxesOf(files)).toEqual(cardBefore)
  expect(await shiftsAfter(cardShifts)).toEqual([])
})
