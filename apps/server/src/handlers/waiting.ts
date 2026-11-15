import type { HubMatter, Waiting } from '@contentops/contracts/domain/waiting'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { hubSlugOf } from './publications'

/**
 * «Ждут вас» of a model (products plan §2.4, §4.4): what waits in Hub for the person, read through
 * their own sign-in through Hub (the session's grant), kept a minute by the sign-in service and
 * never copied into the database. Only the matters of the model's pages (or of no page) are the
 * model's. A matter about a thing ContentOps shows opens ContentOps' own screen in the same tab (a post's card in
 * «Публикации», an order in «Съёмка», «Копии кастомов»); any other opens in Hub — only for a person who has Hub,
 * nobody else is sent to a sign-in page of a product she does not have (package C4).
 */

function hubHref(link: string | null, hubBaseUrl: string | null | undefined): string {
  const hub = hubBaseUrl ? new URL(hubBaseUrl).origin : ''
  if (link === null) return `${hub}/matters`
  if (/^https?:\/\//.test(link)) return link
  return `${hub}${link.startsWith('/') ? link : `/${link}`}`
}

/** ContentOps' own screen for a matter, or null when it is not about a thing ContentOps shows. */
export function ownHref(
  model: string,
  matter: {
    kind: string
    object?: { type: string; id: string } | null
    pageLabels: readonly string[]
  },
): string | null {
  const page = matter.pageLabels[0]
  const publications = (extra: Record<string, string>) =>
    `/${model}/publications?${new URLSearchParams({ window: 'all', ...(page ? { page } : {}), ...extra })}`
  const object = matter.object
  if (object?.type === 'publication' && /^\d+$/.test(object.id)) {
    return publications({ publication: object.id })
  }
  if (object?.type === 'publication_not_published') return publications({})
  if (matter.kind === 'contentops.custom_copy') return `/${model}/inbox/copies`
  if (object?.type === 'custom_order' && /^\d+$/.test(object.id)) {
    return `/${model}/shooting?${new URLSearchParams({ order: `K-${object.id}` })}`
  }
  if (matter.kind.startsWith('content.')) return `/${model}/plan`
  return null
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
        // Hub's own address only for a person who has Hub (the owner); a content manager has not.
        const { rows: held } = await db.execute<{ hub: boolean }>(sql`
          SELECT coalesce('hub' = ANY(hub_products), false) AS hub FROM principals WHERE id = ${actor.id}::uuid`)
        const hasHub = held[0]?.hub === true
        if (answer === 'unreachable') return { hub: 'unreachable', matters: [] }
        const { rows: pages } = await db.execute<{ ref: string }>(sql`
          SELECT hub_page_ref AS ref FROM accounts
           WHERE model_id = ${model.id}::uuid AND hub_page_ref IS NOT NULL`)
        const own = new Set(pages.map((page) => page.ref))
        // By Hub's model, like every other screen (`HUB_MODEL_MAP` read backwards); an older Hub that names no
        // models — by the pages bound here.
        const slug = hubSlugOf(hubSignin.setup.modelMap, model)
        const matters: HubMatter[] = (answer ?? [])
          .filter((matter) =>
            matter.models !== undefined
              ? matter.models.length === 0 || matter.models.includes(slug)
              : matter.pageLabels.length === 0 || matter.pageLabels.some((label) => own.has(label)),
          )
          .flatMap((matter) => {
            const href =
              ownHref(model.code, matter) ??
              (hasHub ? hubHref(matter.link, secrets.hubBaseUrl) : null)
            if (href === null) return []
            return [
              {
                id: matter.id,
                kind: matter.kind,
                title: matter.title,
                href,
                pages: matter.pageLabels,
                opened_at: matter.openedAt.toISOString(),
              },
            ]
          })
        return { hub: 'ok', matters }
      },
    },
  }
}
