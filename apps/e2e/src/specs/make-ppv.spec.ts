import { apiAs, expect, makeMedia, test } from '../fixtures.ts'

/**
 * A new PPV from footage and from a custom with one's own montage (DESIGN §4.5, §6.6;
 * SPEC §6.1): «Сделать мастером PPV» takes a video of the raw shoot as the master as it is;
 * «Сделать PPV» → «Загрузить свой монтаж» sends the montage to the tray, and it is accepted on
 * upload as the master of the new PPV. Both write the link to the source object.
 */

interface IndexEntry {
  id: string
  type: string
  fan_name: 'yes' | 'no' | 'unknown' | null
  ppv_made_as: string | null
}

const RAW = 'RAW-0036'

test('«Сделать мастером PPV»: видео из сырья становится мастером нового PPV', async ({ km }) => {
  const title = `Мастер из сырья ${Date.now().toString(36)}`
  await km.goto(`/lora/i/${RAW}`)
  const main = km.getByRole('main')
  await main.getByRole('checkbox', { name: 'Выбрать «файл 1»' }).check()
  await km.getByRole('button', { name: 'Сделать мастером PPV' }).click()
  const dialog = km.getByRole('dialog', { name: 'Сделать мастером PPV' })
  await dialog.getByRole('radio', { name: 'бандл' }).click()
  await dialog.getByLabel('Название').fill(title)
  await dialog.getByRole('button', { name: 'Создать PPV' }).click()
  const made = km.getByRole('status').filter({ hasText: /Принято → PPV-\d+/ })
  await expect(made).toBeVisible()
  const ppv = /PPV-\d+/.exec((await made.textContent()) ?? '')?.[0] ?? ''
  await expect(dialog).toBeHidden()

  await km.goto(`/lora/i/${ppv}`)
  await expect(km.getByRole('heading', { level: 1 })).toHaveText(title)
  await expect(km.getByRole('main').getByText(/^Бандл на стену · /)).toBeVisible()
  await expect(km.getByRole('main')).toContainText(RAW)
  // The footage keeps its file.
  await km.goto(`/lora/i/${RAW}`)
  await expect(main.getByRole('checkbox', { name: 'Выбрать «файл 1»' })).toBeVisible()
})

test('«Сделать PPV» → «Загрузить свой монтаж»: монтаж принят при загрузке', async ({ km }) => {
  const api = await apiAs('km')
  const index = await api.get<{ items: IndexEntry[] }>('/api/v1/lora/index')
  await api.context.dispose()
  // A custom whose fan's name may sound: only one's own montage makes a PPV of it.
  const custom = index.items.find(
    (entry) => entry.type === 'custom' && entry.fan_name !== 'no' && entry.ppv_made_as === null,
  )?.id
  expect(custom, 'a custom of the seed without a PPV and with a name that may sound').toBeTruthy()

  // No delivered order behind it: «Сделать PPV» is in «⋯» of the card (DESIGN §4.5).
  await km.goto(`/lora/i/${custom}`)
  await km.getByRole('main').getByRole('button', { name: 'Действия объекта' }).click()
  await km.getByRole('menuitem', { name: 'Сделать PPV' }).click()
  const dialog = km.getByRole('dialog', { name: `Сделать PPV из ${custom}` })
  await dialog.getByRole('radio', { name: 'в личку' }).click()
  await expect(dialog.getByRole('radio', { name: 'Загрузить свой монтаж' })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: 'Взять мастер как есть' })).toHaveCount(0)
  const montage = makeMedia('video', `montage-${Date.now().toString(36)}.mp4`, 2)
  await dialog.locator('input[type=file]').setInputFiles(montage)
  await dialog.getByRole('button', { name: 'Загрузить' }).click()
  await expect(dialog).toBeHidden()
  await expect(
    km.getByRole('status').filter({ hasText: `Монтаж загружается → PPV из ${custom}` }),
  ).toBeVisible()
  const line = km
    .getByRole('region', { name: 'Загрузки' })
    .getByRole('listitem')
    .filter({ hasText: montage.split('/').at(-1) as string })
  await expect(line).toContainText(/принято → PPV-\d+/, { timeout: 60_000 })
  const ppv = /PPV-\d+/.exec((await line.textContent()) ?? '')?.[0] ?? ''

  await km.goto(`/lora/i/${ppv}`)
  await expect(km.getByRole('main').getByText(/^В личку/)).toBeVisible()
  await expect(km.getByRole('main')).toContainText(`PPV из кастома`)
  await expect(km.getByRole('main')).toContainText(custom as string)
  await km.goto('/lora/library/customs?view=to-ppv')
  await expect(km.getByRole('link', { name: `→ ${ppv}` })).toBeVisible()
})
