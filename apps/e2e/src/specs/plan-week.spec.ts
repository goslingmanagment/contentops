import { addDays, isoWeekOf } from '@contentops/contracts/clock'
import { formatShortDay } from '@contentops/contracts/format'
import type { Locator, Page } from '@playwright/test'
import { type Api, dbQuery, expect, mskToday, test } from '../fixtures.ts'

/**
 * PLAN 4а «сквозной браузерный сценарий владельца и КМ по этому процессу»; DESIGN §6.3 (неделя
 * плана), §6.4 (выпуск PPV на нескольких страницах), §6.1 (день Дианы). The owner fills the
 * next week from the drawer «Ещё не залито» (two FYPs spread over Fansly 1–3 with unique
 * versions), puts a PPV release on every page by the matrix of the dialog and a set on
 * Fansly 2 for today; Диана opens «День», downloads the row's file (the receipt «Уже
 * скачивала»), marks it and confirms it by hand — Hub is off.
 *
 * Objects of this scenario only: FYP-0406 and FYP-0408 (never in the seeded plan), PPV-077,
 * SET-065 on Fansly 2. Their rows from a previous run on the same stack are unmarked and
 * cancelled first, so the scenario runs again.
 */

const FYPS = ['FYP-0406', 'FYP-0408'] as const
const FYP_TITLE = { 'FYP-0406': 'Шёлковая пижама, йога', 'FYP-0408': 'Красное платье, танец' }
const PPV = 'PPV-077'
const PPV_TITLE = 'Чёрное кружево, отель, танец'
const SET = 'SET-065'
const SET_PAGE = { code: 'lora-2', label: 'Fansly 2' }

/** Rows of this scenario left by an earlier run: unmarked (as the owner may) and cancelled. */
async function cancelEarlierRuns(api: Api) {
  const rows = await dbQuery<{ id: string; marked: boolean }>(
    `SELECT r.id::text, r.marked_at IS NOT NULL AS marked
       FROM posting_plan_rows r
       JOIN content_items i ON i.id = r.item_id
       JOIN accounts a ON a.id = r.account_id
       JOIN models m ON m.id = r.model_id
      WHERE m.code = 'lora' AND r.cancelled_at IS NULL
        AND ((i.type = 'FYP' AND i.number IN (406, 408))
          OR (i.type = 'PPV' AND i.number = 77)
          OR (i.type = 'SET' AND i.number = 65 AND a.code = $1))`,
    [SET_PAGE.code],
  )
  for (const row of rows) {
    if (row.marked) await api.post(`/api/v1/lora/plan/rows/${row.id}:unmark`)
    await api.post(`/api/v1/lora/plan/rows/${row.id}:cancel`, { reason: null })
  }
}

/** «День», «Неделя», «Сверить» — the views of the plan. */
function viewTab(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Вид плана' })
    .getByRole('link', { name, exact: true })
}

/** «12.11» or «12.11.2027» of the summary line → `2026-11-12`. */
function dateOf(text: string, today: string): string {
  const match = /(\d{2})\.(\d{2})(?:\.(\d{4}))?/.exec(text)
  if (!match) throw new Error(`no date in «${text}»`)
  const [, day, month, year] = match
  return `${year ?? today.slice(0, 4)}-${month}-${day}`
}

/** Leaves exactly these pages pressed in the «Страницы» pills of the plan dialog. */
async function choosePages(dialog: Locator, labels: readonly string[]) {
  const pills = dialog.getByRole('toolbar', { name: 'Страницы' }).getByRole('button')
  for (const pill of await pills.all()) {
    const label = (await pill.textContent())?.trim() ?? ''
    const pressed = (await pill.getAttribute('aria-pressed')) === 'true'
    if (pressed !== labels.includes(label) && (await pill.isEnabled())) await pill.click()
  }
  for (const label of labels) {
    await expect(dialog.getByRole('button', { name: label, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
}

test('the owner plans a week and a PPV release, Диана does her day', async ({
  owner,
  km,
  ownerApi,
}) => {
  const today = mskToday()
  const nextWeek = isoWeekOf(addDays(today, 7))
  await cancelEarlierRuns(ownerApi)

  await test.step('owner: the next week, two FYPs from the drawer on Fansly 1–3', async () => {
    await owner.goto(`/lora/plan/w/${nextWeek}`)
    await expect(viewTab(owner, 'Неделя')).toHaveAttribute('aria-current', 'page')
    // Places of the norm are drawn as dashed «+ фуп 03:00» before anything is put there.
    await expect(owner.getByRole('button', { name: '+ фуп 03:00' }).first()).toBeVisible()
    await owner.getByRole('button', { name: 'Ещё не залито' }).click()
    const drawer = owner.getByRole('complementary', { name: 'Ещё не залито' })
    await expect(drawer.getByRole('tab', { name: 'Fansly 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(drawer.getByRole('radio', { name: 'фупы' })).toBeChecked()
    await drawer.getByRole('option', { name: new RegExp(FYPS[0]) }).click()
    await drawer
      .getByRole('option', { name: new RegExp(FYPS[1]) })
      .click({ modifiers: ['ControlOrMeta'] })
    await expect(drawer.getByText(/^Выбрано 2 из \d+$/)).toBeVisible()
    await drawer.getByRole('button', { name: 'Куда разложить' }).click()
    await owner.getByRole('menuitem', { name: 'Fansly 1, 2, 3 · фуп' }).click()

    const dialog = owner.getByRole('dialog', { name: 'В план' })
    await expect(dialog.getByText('2 объекта')).toBeVisible()
    await expect(dialog.getByRole('radio', { name: 'Следующая' })).toBeChecked()
    await expect(dialog.getByRole('radio', { name: 'По пустым местам недели' })).toBeChecked()
    // Each FYP once per page, a unique version per page: version N on Fansly N.
    const preview = dialog.getByRole('checkbox', { name: /^FYP-04\d\d → Fansly [123] · / })
    await expect(preview).toHaveCount(6)
    for (const fyp of FYPS) {
      for (const n of [1, 2, 3]) {
        await expect(
          dialog.getByRole('checkbox', {
            name: new RegExp(`^${fyp} → Fansly ${n} · .*, 03:00 · версия ${n} · `),
          }),
        ).toBeChecked()
      }
    }
    await dialog.getByRole('button', { name: 'Поставить 6' }).click()
    await expect(dialog).toBeHidden()
    await expect(owner.getByText('Поставлено · 6 строк')).toBeVisible()

    // The week shows them in the FYP places; the drawer offers them no more.
    for (const fyp of FYPS) {
      await expect(
        owner.getByRole('button', { name: new RegExp(`^03:00, ${FYP_TITLE[fyp]}, `) }),
      ).toHaveCount(3)
    }
    for (const page of ['Fansly 1', 'Fansly 3']) {
      await drawer.getByRole('tab', { name: page }).click()
      await expect(drawer.getByRole('listbox', { name: `Ещё не залито на ${page}` })).toBeVisible()
      for (const fyp of FYPS) {
        await expect(drawer.getByRole('option', { name: new RegExp(fyp) })).toHaveCount(0)
      }
    }
    await drawer.getByRole('button', { name: 'Закрыть ящик' }).click()
  })

  let releaseDate = ''
  await test.step('owner: a PPV release on every page by the matrix', async () => {
    await owner.getByRole('button', { name: 'В план', exact: true }).click()
    const dialog = owner.getByRole('dialog', { name: 'В план' })
    await dialog.getByRole('textbox', { name: 'Найти объект' }).fill(PPV)
    await dialog.getByRole('button', { name: new RegExp(PPV) }).click()
    await dialog.getByRole('tab', { name: 'Выпуск PPV' }).click()
    await expect(dialog.getByText(`Выпуск ${PPV}`, { exact: true })).toBeVisible()
    // A bundle: wall, mass message (where the wall goes 5+ times a week) and the story teaser.
    for (const page of ['Fansly 1', 'Fansly 2', 'Fansly 3', 'OF VIP', 'OF Free']) {
      await expect(dialog.getByRole('checkbox', { name: `${page} · стена` })).toBeChecked()
      await expect(dialog.getByRole('checkbox', { name: `${page} · сториз-тизер` })).toBeChecked()
      await expect(dialog.getByRole('checkbox', { name: `${page} · vault` })).not.toBeChecked()
    }
    for (const page of ['Fansly 1', 'Fansly 2', 'Fansly 3']) {
      await expect(dialog.getByRole('checkbox', { name: `${page} · рассылка` })).toBeChecked()
    }
    const submit = dialog.getByRole('button', { name: 'Поставить выпуск: 13 строк' })
    await expect(submit).toBeEnabled()
    // The story teaser is exactly where a release puts stories: the check has nothing against
    // it (SPEC §7, DESIGN §4.13 — the check line speaks only of real problems).
    // The check line has answered (it holds its place busy until then).
    await expect(dialog.locator('p[aria-live="polite"]').first()).not.toHaveAttribute(
      'aria-busy',
      'true',
    )
    await expect(
      dialog.getByText(/[Сс]ториз ставится только тизером/),
      'no false refusal of the teaser',
    ).toHaveCount(0, { timeout: 3_000 })
    const summary = dialog.getByText(new RegExp(`^Выпуск ${PPV} · 13 строк на 5 страницах · с `))
    await expect(summary).toBeVisible()
    releaseDate = dateOf((await summary.textContent()) ?? '', today)
    await submit.click()
    await expect(dialog).toBeHidden()
    await expect(owner.getByText(`Выпуск ${PPV} поставлен · 13 строк`)).toBeVisible()

    // The release day by the norm: its rows stand in the week of that day on every page.
    expect(releaseDate >= today).toBe(true)
    await owner.goto(`/lora/plan/w/${isoWeekOf(releaseDate)}`)
    await expect(
      owner.getByRole('button', { name: new RegExp(`^\\d\\d:\\d\\d, ${PPV_TITLE}, `) }),
    ).toHaveCount(13)
  })

  await test.step(`owner: ${SET} on ${SET_PAGE.label} today`, async () => {
    await owner.goto(`/lora/plan/${today}`)
    await owner.getByRole('button', { name: 'В план', exact: true }).click()
    const dialog = owner.getByRole('dialog', { name: 'В план' })
    await dialog.getByRole('textbox', { name: 'Найти объект' }).fill(SET)
    await dialog.getByRole('button', { name: new RegExp(SET) }).click()
    await choosePages(dialog, [SET_PAGE.label])
    await dialog.getByRole('radio', { name: formatShortDay(today) }).click()
    // Диана posts on Fansly pages: the row is hers without choosing anyone.
    await expect(
      dialog.getByText(`${SET} · 1 страница · стена · ${formatShortDay(today)}, 20:00 · Диана`),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Поставить 1' }).click()
    await expect(dialog).toBeHidden()
    await expect(owner.getByText(new RegExp(`^Поставлено · ${SET_PAGE.label} · `))).toBeVisible()
  })

  await test.step('Диана: «День», download the row, mark and confirm', async () => {
    await km.goto(`/lora/plan/${today}?pages=${SET_PAGE.code}`)
    await expect(viewTab(km, 'День')).toHaveAttribute('aria-current', 'page')
    const row = km.getByRole('option').filter({ hasText: `${SET} · стена` })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('в плане')

    const download = km.waitForEvent('download', { timeout: 90_000 })
    await row.getByRole('button', { name: 'Скачать для заливки' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(new RegExp(`^${SET}_.+__${SET_PAGE.code}_${today}`))
    await expect(km.getByText(`Скачивается · ${file.suggestedFilename()}`)).toBeVisible()
    expect(await file.failure()).toBeNull()

    // The receipt of the download lives on the row: «Уже скачивала» in its panel.
    // The copy was built by the worker (202, «Загрузки» tray), so the receipt is sealed after
    // the command answered; the row must show it without a reload.
    await row.dblclick()
    await expect(km.getByText(`Скачать для ${SET_PAGE.label}`)).toBeVisible()
    await expect(
      km.getByText(/^Уже скачивала: .* · метаданные стёрты$/),
      'the receipt shows once the copy is downloaded',
    ).toBeVisible()

    await row.getByRole('button', { name: 'Отметить и подтвердить' }).click()
    await expect(
      km.getByText(new RegExp(`^Отмечено и подтверждено · .+ · ${SET_PAGE.label}$`)),
    ).toBeVisible()
    await expect(row).toContainText('подтверждено')
    await expect(row).toContainText('вручную, Диана')
    await expect(row.getByRole('button', { name: 'Отметить и подтвердить' })).toHaveCount(0)
  })

  await test.step('owner sees the confirmation by hand on the object', async () => {
    await owner.goto(`/lora/i/${SET}`)
    const placed = owner
      .getByRole('list', { name: 'Где залито' })
      .getByRole('button', { name: `${SET_PAGE.label} ${today.slice(8, 10)}.${today.slice(5, 7)}` })
    await expect(placed).toBeVisible()
    await placed.click()
    await expect(owner.getByText(/вручную, Диана/).first()).toBeVisible()
  })
})
