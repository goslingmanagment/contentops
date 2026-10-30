import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, request, test as setup } from '@playwright/test'
import { E2E } from './env.ts'
import { AUTH_DIR, apiAs, type Person, statePath, type Who } from './fixtures.ts'

/**
 * Everyone signs in once. The owner goes through the login screen; Диана, a reader of Лора and
 * a content manager of Ари only sign in by the same command the screen sends. The last two are
 * added by the owner as in «Люди и доступ» and sign in with the temporary password.
 */
setup('sign in: owner on the login screen, the others by the same command', async ({ page }) => {
  mkdirSync(AUTH_DIR, { recursive: true })
  await page.goto('/lora/library')
  await expect(page).toHaveURL(/\/login\?from=/)
  await page.getByLabel('Логин').fill('dmitriy')
  await page.getByLabel('Пароль').fill(E2E.password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page).toHaveURL(/\/lora\/library$/)
  await expect(page.getByRole('heading', { name: /Библиотека/ })).toBeVisible()
  await page.context().storageState({ path: statePath('owner') })

  const owner = await apiAs('owner')
  // A fresh pair each run: the setup may run again on a stack started by hand.
  const suffix = Date.now().toString(36)
  const add = async (name: string, role: string, models: string[]): Promise<Person> => {
    const login = `${role}-${models[0]}-${suffix}`
    const created = await owner.post<{ temporary_password: string }>('/api/v1/admin/people', {
      name,
      login,
      role,
      models,
    })
    return { login, password: created.temporary_password, name }
  }
  const people: Record<Who, Person> = {
    owner: { login: 'dmitriy', password: E2E.password, name: 'Дмитрий' },
    km: { login: 'diana', password: E2E.password, name: 'Диана' },
    reader: await add('Вера Чтение', 'reader', ['lora']),
    stranger: await add('Арина Ари', 'manager', ['ari']),
  }
  await owner.context.dispose()

  for (const who of ['km', 'reader', 'stranger'] as const) {
    const context = await request.newContext({ baseURL: E2E.baseUrl })
    const answer = await context.post('/api/v1/auth/sign-in', {
      data: { login: people[who].login, password: people[who].password },
    })
    expect(answer.status(), await answer.text()).toBe(200)
    await context.storageState({ path: statePath(who) })
    await context.dispose()
  }
  writeFileSync(join(AUTH_DIR, 'people.json'), JSON.stringify(people, null, 2))
})
