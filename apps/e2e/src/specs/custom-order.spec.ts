import type { Locator, Page } from '@playwright/test'
import { apiAs, expect, makeMedia, test } from '../fixtures.ts'

/**
 * PLAN 4б «сквозной сценарий КМ по заказу, сдаче и правке», DESIGN §6.6 по шагам, SPEC §8.2:
 * Диана заводит заказ из текста карточки; ролик приходит веб-загрузкой «Другое» в «Приехало»,
 * она выбирает заказ и нажимает «Принять как сдачу»; добавляет правку; исправление приходит
 * новой версией мастера того же кастома и становится второй сдачей того же заказа; правка —
 * «Выполнена → новая версия»; заказ закрыт; «Переделка в PPV» → «Сделать PPV» → «в личку»,
 * «Взять мастер как есть» → «Создать PPV». Прежняя версия, сдачи и правка остаются в истории.
 */

/** The card of this run: its message id is the order's address. */
const RUN = Date.now() % 1_000_000_000
const CHAT = '2627984998'
const TITLE = `e2e танец ${RUN}`
const ORDER_URL = `/lora/library/customs/orders/tg-${CHAT}-12-${RUN}`
const REVISION = `без музыки, только звук комнаты ${RUN}`

interface InboxGroup {
  id: string
  files: { file_name: string }[]
}

/** The order panel; its first status word is the order's own (the subtitle). */
function orderPanel(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Заказ' })
}

function orderStatus(panel: Locator): Locator {
  return panel.locator('[data-slot="status-word"]').first()
}

/** The line of one file in the upload tray: its name, then «в Приехало» or «принято → …». */
function trayLine(page: Page, file: string): Locator {
  return page
    .getByRole('region', { name: 'Загрузки' })
    .getByRole('listitem')
    .filter({ hasText: file })
}

/** «Загрузить» in the column: the file goes where the window says. */
async function upload(page: Page, file: string, kind?: string): Promise<void> {
  await page
    .getByRole('complementary', { name: 'Колонка' })
    .getByRole('button', { name: 'Загрузить' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Загрузить' })
  if (kind) await dialog.getByRole('radio', { name: kind }).click()
  await dialog.locator('input[type=file]').setInputFiles(file)
  await expect(dialog.getByText(file.split('/').at(-1) as string)).toBeVisible()
  await dialog.getByRole('button', { name: 'Загрузить' }).click()
  await expect(dialog).toBeHidden()
}

test('КМ: заказ → сдача из «Приехало» → правка → исправление → закрыт → PPV из кастома', async ({
  km,
}) => {
  test.setTimeout(300_000)
  const panel = orderPanel(km)

  await test.step('«Новый заказ» из текста карточки', async () => {
    await km.goto('/lora/library/customs?view=orders')
    await km.getByRole('main').getByRole('button', { name: 'Новый заказ' }).first().click()
    const dialog = km.getByRole('dialog', { name: 'Новый заказ' })
    await dialog
      .getByLabel('Текст карточки')
      .fill(`📌 Кастом «${TITLE}»\n👤 фан №${RUN} · Fansly 2\n📄 медленно у окна\n⏱ 3-5 минут`)
    await dialog
      .getByPlaceholder('Ссылка на карточку в Telegram')
      .fill(`https://t.me/c/${CHAT}/12/${RUN}`)
    // The card is parsed into the fields; the person checks them before «Сохранить».
    await expect(dialog.getByLabel('Покупатель')).toHaveValue(`фан №${RUN}`)
    await expect(dialog.getByRole('combobox', { name: 'Страница' })).toHaveText('Fansly 2')
    await expect(dialog.getByRole('checkbox', { name: /видео · 3–5 мин/ })).toBeChecked()
    // The fan's name does not sound in the video: the PPV can take the master as it is.
    await dialog
      .getByRole('radiogroup', { name: 'Имя фана в ролике' })
      .getByRole('radio', { name: 'нет' })
      .click()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(dialog).toBeHidden()
    const toast = km.getByRole('status').filter({ hasText: `Заказ заведён · ${TITLE}` })
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: 'Открыть' }).click()
    await expect(km).toHaveURL(ORDER_URL)
    await expect(panel.getByRole('heading', { name: `Кастом «${TITLE}»` })).toBeVisible()
    await expect(orderStatus(panel)).toHaveText(/^ждём от Лоры/)
    await expect(panel.getByText('Сдач пока нет')).toBeVisible()
    await expect(
      km.getByRole('listbox', { name: 'Заказы' }).getByRole('option', { name: new RegExp(TITLE) }),
    ).toContainText('ждём от Лоры')
  })

  const delivery = `e2e-delivery-${RUN}.mp4`
  let custom = ''
  await test.step('сдача: веб-загрузка «Другое», в «Приехало» — заказ и «Принять как сдачу»', async () => {
    await upload(km, makeMedia('video', delivery, 2))
    await expect(trayLine(km, delivery)).toContainText('в Приехало')
    // «Загружено вами · 1 видео» is not unique: the group is found by the file name.
    const api = await apiAs('km')
    let group = ''
    await expect(async () => {
      const list = await api.get<{ items: InboxGroup[] }>('/api/v1/lora/inbox')
      group =
        list.items.find((item) => item.files.some((file) => file.file_name === delivery))?.id ?? ''
      expect(group).not.toBe('')
    }).toPass()
    await api.context.dispose()

    await km.goto(`/lora/inbox/g/${group}`)
    const decision = km.getByRole('complementary', { name: 'Решение' })
    await expect(decision.getByRole('checkbox', { name: `Выбрать ${delivery}` })).toBeVisible()
    await decision.getByRole('radio', { name: 'Кастом' }).click()
    await expect(
      decision.getByRole('radiogroup', { name: 'Тип' }).getByRole('radio', { name: 'Кастом' }),
    ).toBeChecked()
    // «Заказ» of the custom: the open orders of the model, this one by its title.
    await decision.getByRole('combobox', { name: 'Заказ' }).click()
    await km.getByRole('option', { name: new RegExp(`^«${TITLE}»`) }).click()
    await expect(decision.getByRole('link', { name: new RegExp(`«${TITLE}»`) })).toBeVisible()
    // The master is built by the media worker before the button opens.
    const accept = decision.getByRole('button', { name: 'Принять как сдачу' })
    await expect(accept).toBeEnabled({ timeout: 150_000 })
    await accept.click()
    const accepted = km.getByRole('status').filter({ hasText: /Принято → CUS-\d+/ })
    await expect(accepted).toBeVisible()
    custom = /CUS-\d+/.exec((await accepted.textContent()) ?? '')?.[0] ?? ''
    expect(custom).toMatch(/^CUS-\d+$/)
  })

  await test.step('заказ ✓: сдача из «Приехало» записана, часть «видео» сдана', async () => {
    await km.goto(ORDER_URL)
    await expect(orderStatus(panel)).toHaveText(/^сдано/)
    await expect(panel.getByRole('link', { name: custom }).first()).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Закрыть заказ' })).toBeEnabled()
  })

  await test.step('правка с требованием и ссылкой на сообщение', async () => {
    await panel.getByRole('button', { name: 'Добавить правку' }).click()
    await panel.getByLabel('Что поправить').fill(REVISION)
    await panel.getByLabel('Ссылка на сообщение').fill(`https://t.me/c/${CHAT}/12/${RUN + 1}`)
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    await expect(km.getByRole('status').filter({ hasText: 'Правка добавлена' })).toBeVisible()
    await expect(orderStatus(panel)).toHaveText(`правка · «${REVISION}»`)
    const revision = panel.getByRole('listitem').filter({ hasText: `«${REVISION}»` })
    await expect(revision.locator('[data-slot="status-word"]')).toHaveText('открыта')
    await expect(panel.getByText('Сначала отметьте правку выполненной')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Закрыть заказ' })).toHaveCount(0)
  })

  const fixed = `e2e-fixed-${RUN}.mp4`
  await test.step('исправление — новая версия мастера того же кастома; прежняя остаётся', async () => {
    await panel.getByRole('link', { name: custom }).first().click()
    await expect(km).toHaveURL(`/lora/i/${custom}`)
    await expect(km.getByRole('main').getByRole('button', { name: 'Открыть заказ' })).toBeVisible()
    await upload(km, makeMedia('video', fixed, 2), 'Новая версия мастера')
    await expect(trayLine(km, fixed)).toContainText(`принято → ${custom}`, { timeout: 150_000 })
    const master = km.getByRole('region', { name: 'Мастер' })
    await expect(master.getByRole('option', { name: /мастер v2/ })).toBeVisible()
    await expect(master.getByRole('button', { name: /Мастер v1 до правки/ })).toBeVisible()
  })

  await test.step('исправление — вторая сдача того же заказа', async () => {
    await km.getByRole('main').getByRole('button', { name: 'Открыть заказ' }).click()
    await expect(km).toHaveURL(ORDER_URL)
    await expect(panel.getByRole('link', { name: custom })).toHaveCount(2)
  })

  await test.step('правка выполнена новой версией, заказ закрыт; история на месте', async () => {
    await panel.getByRole('button', { name: 'Выполнена' }).first().click()
    await km.getByRole('menuitem', { name: 'новая версия' }).click()
    await expect(km.getByRole('status').filter({ hasText: 'Правка выполнена' })).toBeVisible()
    const revision = panel.getByRole('listitem').filter({ hasText: `«${REVISION}»` })
    await expect(revision.locator('[data-slot="status-word"]')).toHaveText(/^выполнена/)
    await expect(orderStatus(panel)).toHaveText(/^сдано/)

    await panel.getByRole('button', { name: 'Закрыть заказ' }).click()
    await expect(
      km.getByRole('status').filter({ hasText: `Заказ закрыт · ${TITLE}` }),
    ).toBeVisible()
    await expect(orderStatus(panel)).toHaveText('закрыт')
    // Closed is read-only, and nothing of the path is lost.
    await expect(panel.getByRole('button', { name: 'Добавить правку' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Привязать сдачу…' })).toHaveCount(0)
    await expect(panel.getByRole('link', { name: custom }).first()).toBeVisible()
    await expect(revision).toBeVisible()

    await km
      .getByRole('toolbar', { name: 'Фильтры' })
      .getByRole('button', { name: 'Закрытые' })
      .click()
    await expect(
      km.getByRole('listbox', { name: 'Заказы' }).getByRole('option', { name: new RegExp(TITLE) }),
    ).toBeVisible()
  })

  await test.step('PPV из кастома: «в личку», мастер как есть, связь пишется сама', async () => {
    await km.goto('/lora/library/customs?view=to-ppv')
    // Customs without the fan's name come first, the latest delivered on top.
    const row = km
      .getByRole('main')
      .locator('div')
      .filter({ has: km.getByText(custom, { exact: true }) })
      .filter({ has: km.getByRole('button', { name: 'Сделать PPV' }) })
      .last()
    await expect(row).toContainText('имени нет')
    await row.getByRole('button', { name: 'Сделать PPV' }).click()
    const dialog = km.getByRole('dialog', { name: `Сделать PPV из ${custom}` })
    await dialog.getByRole('radio', { name: 'в личку' }).click()
    await expect(dialog.getByRole('radio', { name: 'Взять мастер как есть' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Создать PPV' }).click()
    const made = km.getByRole('status').filter({ hasText: /Принято → PPV-\d+/ })
    await expect(made).toBeVisible()
    const ppv = /PPV-\d+/.exec((await made.textContent()) ?? '')?.[0] ?? ''
    await expect(dialog).toBeHidden()
    await expect(km.getByRole('link', { name: `→ ${ppv}` })).toBeVisible()

    // The PPV is a new object over the same master, «в личку», linked to the custom.
    await km.goto(`/lora/i/${ppv}`)
    const card = km.getByRole('main')
    await expect(card.getByText(/^В личку · /)).toBeVisible()
    await expect(card.getByRole('heading', { level: 1 })).toHaveText(`e2e танец ${RUN}`)
    await expect(card).toContainText(`PPV из кастома${`e2e танец ${RUN}`} · ${custom}`)
  })
})
