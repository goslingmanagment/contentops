import type { Db } from '@contentops/db'
import { type HubRefusal, type HubSignedIn, isHubError } from '@contentops/hub'
import { ApiProblem } from '../errors'
import { type HubSigninService, openHubSession } from './hub-signin'

/**
 * ContentOps' own entrance (products plan, package C4): the form on ContentOps' page asks Hub — one registry, one
 * account, Hub's own sign-in with its lockout and journal — and opens ContentOps' own session over Hub's grant, as the
 * sign-in through Hub does. ContentOps never keeps the password and never logs it. Every refusal is plain words.
 */

/** What a person reads under the form; the owner's case carries `reason: owner` for the button to Hub. */
export const REFUSAL_WORDS: Record<HubRefusal, string> = {
  wrong: 'Логин или пароль не подходят',
  locked: 'Слишком много попыток входа. Подождите несколько минут и попробуйте снова',
  owner: 'Владелец входит через Hub',
  no_access: 'У вас нет доступа к ContentOps. Попросите владельца',
  link_unknown: 'Ссылка не подходит. Попросите у владельца новую ссылку',
  link_used:
    'Эта ссылка уже использована. Нет пароля или забыли его? Попросите у владельца новую ссылку',
  link_expired: 'Срок ссылки истёк. Попросите у владельца новую ссылку',
  link_revoked: 'Ссылка отозвана. Попросите у владельца новую ссылку',
  not_here: 'Эта ссылка не для ContentOps: откройте её там, откуда её прислали',
  weak: 'Такой пароль не подходит: возьмите длиннее и не из простых',
}

export const HUB_SILENT_WORDS =
  'Вход сейчас недоступен: сервер учётных записей не отвечает. Попробуйте через несколько минут'

/** A refusal as the API's problem: the status the form reads, the reason for the owner's button. */
export function refusalProblem(reason: HubRefusal): ApiProblem {
  const words = REFUSAL_WORDS[reason]
  switch (reason) {
    case 'wrong':
      return new ApiProblem('unauthenticated', words, { reason })
    case 'locked':
      return new ApiProblem('rate_limited', words, { reason }, 300)
    case 'owner':
    case 'no_access':
    case 'not_here':
      return new ApiProblem('forbidden', words, { reason })
    default:
      return new ApiProblem('invalid_request', words, { reason })
  }
}

export interface FormRequest {
  id: string
  ip: string
  userAgent: string | null
  /** The session this browser had: replaced by the new one. */
  previous: string | undefined
  /** ContentOps' form or an invitation's «Придумайте пароль»: how the profile names the session. */
  via: 'form' | 'link'
}

export type HubFormOutcome =
  | { kind: 'signed_in'; token: string }
  | { kind: 'refused'; reason: HubRefusal }
  | { kind: 'unreachable' }

/**
 * Asks Hub and, signed in there, opens ContentOps' session for the person Hub names (people from Hub, package C1):
 * nobody here for them — `no_access`. Hub that does not answer (or answers out of its contract) — `unreachable`.
 */
export async function throughHub(
  db: Db,
  service: HubSigninService,
  ask: () => Promise<HubSignedIn>,
  request: FormRequest,
  log: { warn: (object: object, message: string) => void },
): Promise<HubFormOutcome> {
  let answer: HubSignedIn
  try {
    answer = await ask()
  } catch (error) {
    // Hub's limit of tries from this address: said as «слишком много попыток», not as a silent Hub.
    if (isHubError(error, 'rate_limited')) return { kind: 'refused', reason: 'locked' }
    log.warn({ err: error }, 'hub did not answer the sign-in form')
    return { kind: 'unreachable' }
  }
  if (answer.kind === 'refused') return { kind: 'refused', reason: answer.reason }
  const token = await openHubSession(db, service.setup, answer.redeemed, {
    id: request.id,
    userAgent: request.userAgent,
    previous: request.previous,
    via: request.via,
  })
  return token === null ? { kind: 'refused', reason: 'no_access' } : { kind: 'signed_in', token }
}
