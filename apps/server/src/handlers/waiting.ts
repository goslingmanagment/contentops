import type { HubMatter, Waiting } from '@contentops/contracts/domain/waiting'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'

/**
 * «Ждут вас» of a model (products plan §2.4, §4.4): what waits in Hub for the person, read through
 * their own sign-in through Hub (the session's grant), kept a minute by the sign-in service and
 * never copied into the database. Only the matters of the model's pages (or of no page) are the
 * model's. A matter opens where it is decided: Hub's or Workboard's address, or a path here.
 */

export function hrefOf(
  link: string | null,
  hubBaseUrl: string | null | undefined,
  ownOrigin: string | null = null,
): string {
  const hub = hubBaseUrl ? new URL(hubBaseUrl).origin : ''
  if (link === null) return `${hub}/matters`
  if (/^https?:\/\//.test(link)) {
    // A link to here (a publication's matter opens «Публикации», products plan §2.4): a path of ours.
    const url = new URL(link)
    return ownOrigin !== null && url.origin === ownOrigin
      ? `${url.pathname}${url.search}${url.hash}`
      : link
  }
  return `${hub}${link.startsWith('/') ? link : `/${link}`}`
}

export function waitingHandlers({ db, secrets, hubSignin }: Services): HandlerRegistry {
  return {
    waiting: {
      list: async ({ ctx }): Promise<Waiting> => {
        const actor = requireActor(ctx)
        const model = modelOf(ctx.model)
        if (actor.type !== 'person' || !actor.sessionId || !hubSignin)
          return { hub: 'no_hub', matters: [] }
        const { rows } = await db.execute<{ hub_grant: string | null }>(sql`
          SELECT hub_grant FROM sessions WHERE id = ${actor.sessionId}::uuid`)
        const grant = rows[0]?.hub_grant ?? null
        if (grant === null) return { hub: 'no_hub', matters: [] }
        const answer = await hubSignin.waiting(grant)
        if (answer === 'unreachable') return { hub: 'unreachable', matters: [] }
        const { rows: pages } = await db.execute<{ ref: string }>(sql`
          SELECT hub_page_ref AS ref FROM accounts
           WHERE model_id = ${model.id}::uuid AND hub_page_ref IS NOT NULL`)
        const own = new Set(pages.map((page) => page.ref))
        const matters: HubMatter[] = (answer ?? [])
          .filter(
            (matter) =>
              matter.pageLabels.length === 0 || matter.pageLabels.some((label) => own.has(label)),
          )
          .map((matter) => ({
            id: matter.id,
            kind: matter.kind,
            title: matter.title,
            href: hrefOf(matter.link, secrets.hubBaseUrl, new URL(hubSignin.setup.origin).origin),
            pages: matter.pageLabels,
            opened_at: matter.openedAt.toISOString(),
          }))
        return { hub: 'ok', matters }
      },
    },
  }
}
