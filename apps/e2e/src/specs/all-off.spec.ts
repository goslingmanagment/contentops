import { readFileSync } from 'node:fs'
import { expect, makeMedia, mskToday, test } from '../fixtures.ts'

/**
 * PLAN 1а: the common scenario «всё выключено», whole, in the browser — every integration off
 * and no secret in the stack: upload, accept, find, download, put into the plan, mark by hand.
 * The owner goes through it as on the pilot before Hub (DESIGN §6.10: the owner's week).
 */
test('«всё выключено»: загрузить, принять, найти, скачать, поставить в план, отметить вручную', async ({
  owner: page,
}) => {
  const title = `Всё выключено ${Date.now().toString(36)}`
  const photo = makeMedia('photo')

  // Загрузить: the web upload over tus, «Другое» → a group «Загружено вами» in «Приехало».
  await page.goto('/lora/library')
  await page
    .getByRole('complementary', { name: 'Колонка' })
    .getByRole('button', { name: 'Загрузить' })
    .click()
  const upload = page.getByRole('dialog', { name: 'Загрузить' })
  await expect(upload.getByRole('radio', { name: 'Другое' })).toBeChecked()
  await expect(upload.getByText('В Приехало, группой «Загружено вами»')).toBeVisible()
  await upload.locator('input[type=file]').setInputFiles(photo)
  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/lora/uploads') && response.request().method() === 'POST',
  )
  await upload.getByRole('button', { name: 'Загрузить' }).click()
  const { group_id: group } = (await (await registered).json()) as { group_id: string }
  const tray = page.getByRole('region', { name: 'Загрузки' })
  await expect(tray.getByText(/в Приехало · Что это\?/)).toBeVisible()

  // Принять: the type is not legacy-numbered any more (seed), so a new number is issued.
  await page.goto(`/lora/inbox/g/${group}`)
  await expect(page.getByText('Dropbox · не настроено')).toBeVisible()
  const panel = page.getByRole('complementary', { name: 'Решение' })
  await expect(panel.getByText('загружено через браузер · Дмитрий', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Принять' })).toBeDisabled()
  // Type and title right one after the other: the saves of a group go in turn, no 412 on
  // oneself.
  await panel.getByRole('radio', { name: 'Сет' }).click()
  await panel.getByRole('textbox', { name: 'Название' }).fill(title)
  await panel.getByRole('textbox', { name: 'Название' }).blur()
  await expect(page.getByRole('status').filter({ hasText: 'Сохранено' })).toBeVisible()
  await expect(panel.getByRole('heading', { name: title })).toBeVisible()
  // The photo becomes its own master in `worker-image`; until then «Принять» waits.
  await expect(panel.getByRole('button', { name: 'Принять' })).toBeEnabled({ timeout: 60_000 })
  await panel.getByRole('button', { name: 'Принять' }).click()
  const accepted = page.getByRole('status').filter({ hasText: /Принято → SET-\d+/ })
  await expect(accepted).toBeVisible()
  const id = /SET-\d+/.exec((await accepted.textContent()) ?? '')?.[0] as string

  // Найти: the search box of the shell suggests the object by its title.
  await page.goto('/lora/library')
  const search = page.getByRole('combobox', { name: 'Поиск' })
  await search.click()
  await search.fill(title)
  await page.getByRole('option', { name: `${title} ${id} · Сеты` }).click()
  await expect(page).toHaveURL(new RegExp(`/lora/i/${id}$`))
  const card = page.getByRole('main')
  await expect(card.getByRole('heading', { level: 1, name: title })).toBeVisible()

  // Скачать: the server seals a receipt, the browser gets the file by its address.
  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: 'Скачать', exact: true }).click()
  const file = await download
  expect(file.url()).toMatch(/\/api\/v1\/lora\/downloads\/[0-9a-f-]{36}$/)
  expect(file.suggestedFilename()).toMatch(new RegExp(`^${id}_vse-vyklyucheno-.+\\.jpg$`))
  // A JPEG of the object (metadata may be stripped on the way out, so not byte-equal).
  const bytes = readFileSync(await file.path())
  expect(bytes.length).toBeGreaterThan(10_000)
  expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff')

  // Поставить в план: one page, today, the norm's time.
  await card.getByRole('button', { name: 'В план' }).click()
  const plan = page.getByRole('dialog', { name: 'В план' })
  const pages = plan.getByRole('toolbar', { name: 'Страницы' })
  for (const name of ['Fansly 1', 'Fansly 2', 'OF VIP', 'OF Free']) {
    await pages.getByRole('button', { name }).click()
  }
  await expect(pages.getByRole('button', { name: 'Fansly 3' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await plan.getByRole('button', { name: 'Поставить 1' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Поставлено · Fansly 3' })).toBeVisible()

  // Отметить вручную: Hub is off, so the row offers «Отметить и подтвердить».
  await page.goto(`/lora/plan/${mskToday()}`)
  await expect(page.getByText('Hub не настроен')).toBeVisible()
  const row = page.getByRole('listbox', { name: 'Строки дня' }).getByRole('option').filter({
    hasText: title,
  })
  await expect(row.getByRole('button', { name: 'в плане' })).toBeVisible()
  await row.getByRole('button', { name: 'Отметить и подтвердить' }).click()
  await expect(row.getByRole('button', { name: 'подтверждено' })).toBeVisible()
  await expect(row).toContainText('вручную, Дмитрий')
  await expect(row.getByRole('button', { name: 'Отметить и подтвердить' })).toHaveCount(0)

  // The card says the same after a reload: the confirmation is the server's — Fansly 3 has
  // today's date, the other pages are still «не видели».
  await page.goto(`/lora/i/${id}`)
  const [, month, day] = mskToday().split('-')
  const where = page.getByRole('list', { name: 'Где залито' })
  await expect(where.getByRole('button', { name: /Fansly 3/ })).toContainText(`${day}.${month}`)
  await expect(where.getByRole('button', { name: /Fansly 1/ })).toContainText('не видели')
})
