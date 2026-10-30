import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures.ts'

/**
 * PLAN 4в «сквозной сценарий подборки и передачи», DESIGN §6.7, SPEC §7.1: the content
 * manager adds two PPV masters of the library to a new Reddit collection by reference,
 * prepares a handoff to a contractor with the «мастер» format, the `worker` role builds the
 * ZIP with the manifest, she downloads it, marks it «Передано», and the handoff stays in the
 * history: in the collection, on the collection's card and on the source object.
 */

const SOURCES = ['PPV-080', 'PPV-081'] as const

/** Names of the entries of a ZIP, from its central directory. */
function zipEntries(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end, 'end of the central directory').toBeGreaterThanOrEqual(0)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const nameLength = zip.readUInt16LE(at + 28)
    const extra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    names.push(zip.toString('utf8', at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extra
  }
  return names
}

/** The toast of a command: shown only after the server answered (SPEC §12.0). */
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

test('promo: a collection by reference, a handoff prepared, downloaded and «Передано»', async ({
  km,
  ownerApi,
}) => {
  // The owner keeps the contractors in «Настройки» (owner-only); the KM only picks one.
  const suffix = Date.now().toString(36)
  const contractor = `E2E Promo ${suffix}`
  await ownerApi.post('/api/v1/admin/models/lora/contractors', {
    name: contractor,
    channel: 'reddit',
    contact: null,
    format: 'master',
  })

  // Library › PPV: select two objects, «В промо ▾» → Reddit → «Новая подборка».
  await km.goto('/lora/library/ppv')
  for (const id of SOURCES) {
    const tile = km.locator(`[data-entry-id="${id}"]`)
    await tile.scrollIntoViewIfNeeded()
    await tile.hover()
    await tile.getByRole('checkbox').check()
  }
  await km.getByRole('button', { name: 'В промо' }).click()
  await km.getByRole('menuitem', { name: 'Reddit' }).hover()
  await km.getByRole('menuitem', { name: 'Новая подборка' }).click()
  const added = toast(km, /Добавлено в PRM-\d+/)
  await expect(added).toBeVisible()
  const collection = (/PRM-\d+/.exec((await added.textContent()) ?? '') ?? [])[0] as string
  expect(collection).toMatch(/^PRM-\d+$/)

  // Библиотека → Промо → Reddit → the new collection, as DESIGN §6.7 walks it.
  await km.goto('/lora/library')
  await km
    .getByRole('link', { name: /^Промо/ })
    .first()
    .click()
  await expect(km).toHaveURL(/\/lora\/library\/promo$/)
  await km
    .getByRole('link', { name: /^Reddit/ })
    .first()
    .click()
  await expect(km).toHaveURL(/\/lora\/library\/promo\/reddit$/)
  await km.getByRole('link', { name: new RegExp(`Reddit · ${collection}`) }).click()
  await expect(km).toHaveURL(new RegExp(`/lora/library/promo/reddit/${collection}$`))
  await expect(km.getByRole('heading', { name: `Reddit · ${collection}` })).toBeVisible()
  // Two masters by reference: the bytes stay with the source objects.
  await expect(km.getByText(`${collection} · 2 видео`)).toBeVisible()

  // Step 1: contractor, composition, «Подготовить».
  await km.getByRole('button', { name: 'Подготовить передачу' }).click()
  const form = km.getByRole('complementary', { name: 'Подготовить передачу' })
  await form.getByRole('combobox', { name: 'Подрядчик' }).click()
  await km.getByRole('option', { name: contractor }).click()
  await expect(form.getByText('формат: мастер')).toBeVisible()
  await expect(form.getByText(/^2 видео · ≈/)).toBeVisible()
  await form.getByRole('button', { name: 'Подготовить' }).click()

  // Step 2: «готовится» in the panel and the tray until the worker built the ZIP.
  const panel = km.getByRole('complementary', { name: `Передача ${collection}` })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('подготовлено').first()).toBeVisible({ timeout: 60_000 })
  await expect(panel.getByRole('paragraph').filter({ hasText: contractor })).toBeVisible()
  // The history of the collection already lists it as prepared.
  await expect(panel.getByRole('button', { name: `${contractor} подготовлено` })).toBeVisible()
  await expect(panel.getByText('мастер · метаданные стёрты')).toBeVisible()

  // The ZIP goes to the browser under its real name.
  const zipName = `${collection}_e2e-promo-${suffix}.zip`
  const [download] = await Promise.all([
    km.waitForEvent('download'),
    panel.getByRole('button', { name: 'Скачать ZIP' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(zipName)
  expect(await download.failure()).toBeNull()
  await expect(toast(km, `Скачивается · ${zipName}`)).toBeVisible()
  // The issue under naming §6: two-digit order, the source IDs, `manifest.csv` last.
  const entries = zipEntries(await readFile(await download.path()))
  expect(entries).toHaveLength(3)
  expect(entries.slice(0, 2).sort((a, b) => a.slice(-10).localeCompare(b.slice(-10)))).toEqual([
    expect.stringMatching(new RegExp(`^${collection}_0[12]_PPV-080\\.mp4$`)),
    expect.stringMatching(new RegExp(`^${collection}_0[12]_PPV-081\\.mp4$`)),
  ])
  expect(
    entries.slice(0, 2).map((name) => name.slice(collection.length, collection.length + 4)),
  ).toEqual(['_01_', '_02_'])
  expect(entries.at(-1)).toBe('manifest.csv')

  // «Передано»: the toast and the word come after the server confirmed it.
  await panel.getByRole('button', { name: 'Передано' }).click()
  await expect(toast(km, `Передано · ${contractor}`)).toBeVisible()
  await expect(panel.getByText('передано').first()).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Новая передача' })).toBeVisible()
  const history = panel.getByRole('button', { name: new RegExp(`${contractor}.*передано`) })
  await expect(history).toHaveCount(1)

  // History of the model: Промо › «Передачи» lists it as sent; the row opens the handoff.
  await km.goto('/lora/library/promo?view=handoffs')
  const row = km.locator('[data-selected]').filter({ hasText: contractor })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(`${collection} · Reddit · ${collection}`)
  await expect(row).toContainText('2 видео')
  await expect(row).toContainText('передано')
  await row.getByRole('button').click()
  await expect(km).toHaveURL(new RegExp(`/lora/library/promo/reddit/${collection}`))
  await expect(panel.getByRole('button', { name: 'Новая передача' })).toBeVisible()
  await expect(panel.getByRole('button', { name: `${contractor} передано` })).toHaveAttribute(
    'aria-current',
    'true',
  )

  // The collection's card (`/i/PRM-…` opens the collection): «Сведения» › its handoffs.
  await km.goto(`/lora/i/${collection}`)
  await expect(km).toHaveURL(new RegExp(`/lora/library/promo/reddit/${collection}$`))
  await km.getByRole('button', { name: 'Сведения' }).click()
  await expect(km.getByRole('button', { name: `${contractor} передано` })).toBeVisible()

  // The source object knows where it went (SPEC §7.1).
  await km.goto(`/lora/i/${SOURCES[0]}`)
  await expect(km.getByText(new RegExp(`${collection} · Reddit`))).toBeVisible()
  await expect(km.getByText(new RegExp(`${contractor} .*\\(${collection}\\)`))).toBeVisible()
})
