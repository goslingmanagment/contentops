/**
 * Молчаливый вход через хаб (SPEC §11.1): страница без сеанса один раз уходит в хаб, пока
 * не показан экран входа. В хабе вошли — человек сразу на той же странице, нет — экран входа.
 * Сервер ставит отметки до ухода (`co_hub_try` на 10 минут, `co_hub_out` после «Выйти» до
 * конца сеанса браузера); здесь они только читаются, чтобы не уходить зря. Решает сервер
 * (`/auth/hub/start?silent=1`): он же спрашивает, отвечает ли хаб.
 */

const MARKED = /(?:^|;\s*)(?:__Host-)?co_hub_(?:try|out)=1(?:;|$)/

function marked(): boolean {
  return MARKED.test(document.cookie)
}

/** Хаб предлагается на этом адресе (`GET /api/v1/auth/methods`): только публичное имя. */
async function hubOffered(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/auth/methods', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) return false
    const body = (await response.json()) as { hub?: unknown }
    return body.hub === true
  } catch {
    return false
  }
}

let leaving: Promise<boolean> | null = null

/**
 * `true` — страница уходит в хаб (`from` — куда вернуться); `false` — молчаливой попытки не
 * будет, нужен экран входа. Несколько 401 подряд дают одну попытку.
 */
export function leaveForSilentHubSignIn(from: string): Promise<boolean> {
  leaving ??= (async () => {
    if (marked() || !(await hubOffered()) || marked()) return false
    window.location.replace(`/auth/hub/start?${new URLSearchParams({ silent: '1', next: from })}`)
    return true
  })().finally(() => {
    leaving = null
  })
  return leaving
}
