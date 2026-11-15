import type { ProductLink } from '@contentops/contracts/domain/people'

/**
 * The products' switcher of the frame (products plan §2.1): the list is Hub's (`auth/me` `products`,
 * kept on the principal at every sign-in and re-check through Hub); the addresses are where each opens
 * from here, one step and no second sign-in: Hub's console and Workboard on Hub's names (Hub hands the
 * session on), Задачи and Монитор on their own names beside Hub's (each signs in through Hub).
 */

const LABEL: Record<ProductLink['id'], string> = {
  hub: 'Hub',
  workboard: 'Workboard',
  contentops: 'ContentOps',
  tasks: 'Задачи',
  monitor: 'Монитор',
}

const QUIET: ReadonlySet<ProductLink['id']> = new Set(['tasks', 'monitor'])

function isProduct(id: string): id is ProductLink['id'] {
  return id in LABEL
}

/** `hub.example` → `tasks.example`; null when Hub's name is not `hub.…`. */
function sibling(hubBaseUrl: string, name: string): string | null {
  const url = new URL(hubBaseUrl)
  if (!url.hostname.startsWith('hub.')) return null
  url.hostname = `${name}.${url.hostname.slice('hub.'.length)}`
  return `${url.origin}/`
}

/** Fewer than two products, or no Hub configured: no switcher. */
export function productLinks(
  products: readonly string[] | null,
  hubBaseUrl: string | null | undefined,
): ProductLink[] {
  if (!products || !hubBaseUrl) return []
  const hub = new URL(hubBaseUrl).origin
  const links = products.filter(isProduct).flatMap((id): ProductLink[] => {
    const href =
      id === 'contentops'
        ? '/'
        : id === 'hub'
          ? `${hub}/`
          : id === 'workboard'
            ? `${hub}/workboard/`
            : sibling(hubBaseUrl, id)
    return href === null
      ? []
      : [{ id, label: LABEL[id], href, current: id === 'contentops', quiet: QUIET.has(id) }]
  })
  return links.length < 2 ? [] : links
}
