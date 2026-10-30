import { mskInstant } from '@contentops/contracts/clock'
import type { AccessGrant, AiSettings, Session } from '@contentops/contracts/domain/admin'
import { PERSON } from './people'
import type { AdminRecords } from './world-types'

/** History of rights, sessions and the AI service of DESIGN §9.2, §9.8. */

function grant(date: string, time: string, by: string, text: string): AccessGrant {
  return { at: mskInstant(date, time), by, text }
}

function session(id: string, device: string, date: string, time: string): Session {
  return { id, device, last_seen_at: mskInstant(date, time), current: false }
}

/** The first session of a person is the browser the prototype is opened in. */
function sessions(...list: Session[]): Session[] {
  return list.map((entry, index) => ({ ...entry, current: index === 0 }))
}

/** AI is not connected by default: no services, no budget (DESIGN §9.8). */
export function emptyAiSettings(): AiSettings {
  return { services: [], budget_month_usd: null, spent_month_usd: 0, stopped: null }
}

/** AI connected earlier; `?demo=ai-off` shows it stopped by the system. */
export function connectedAiSettings(stopped: AiSettings['stopped']): AiSettings {
  return {
    services: [
      {
        id: 'ai-markup',
        name: 'Сервис разметки',
        tasks: ['markup', 'timeline'],
        consent: { by: 'Дмитрий', at: mskInstant('2026-09-15', '12:10') },
        spent_month_usd: 14.2,
      },
      {
        id: 'ai-texts',
        name: 'Сервис текстов',
        tasks: ['texts'],
        consent: null,
        spent_month_usd: 0,
      },
    ],
    budget_month_usd: 40,
    spent_month_usd: 14.2,
    stopped,
  }
}

export function buildAdminRecords(): AdminRecords {
  return {
    grants: new Map([
      [PERSON.dmitriy, [grant('2026-08-28', '10:00', 'Система', 'Владелец · все модели')]],
      [
        PERSON.diana,
        [
          grant('2026-09-10', '12:40', 'Дмитрий', 'добавил Lily'),
          grant('2026-09-01', '09:30', 'Дмитрий', 'выдал роль «Контент-менеджер» · Лора'),
        ],
      ],
      [
        PERSON.nikita,
        [grant('2026-09-01', '09:35', 'Дмитрий', 'выдал роль «Контент-менеджер» · Лора')],
      ],
      [
        PERSON.fyper,
        [grant('2026-09-12', '15:20', 'Дмитрий', 'выдал роль «Только чтение» · Лора')],
      ],
    ]),
    sessions: new Map([
      [
        PERSON.dmitriy,
        sessions(
          session('s-dmitriy-mac', 'Chrome на Mac', '2026-09-22', '14:20'),
          session('s-dmitriy-phone', 'Safari на iPhone', '2026-09-21', '23:10'),
        ),
      ],
      [PERSON.diana, sessions(session('s-diana-pc', 'Chrome на Windows', '2026-09-22', '14:20'))],
      [PERSON.nikita, sessions(session('s-nikita-pc', 'Chrome на Windows', '2026-09-22', '13:02'))],
      [PERSON.fyper, sessions(session('s-fyper-api', 'Сервис Fyper', '2026-09-21', '19:40'))],
    ]),
    ai: emptyAiSettings(),
  }
}
