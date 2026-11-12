import type { IncomingHttpHeaders } from 'node:http'
import { ApiProblem } from './errors'

/**
 * A change made by a browser is taken only from a page of ContentOps itself (cross-site request forgery, a sign-in
 * forged from another site): its own name, whichever the person opened (the public one, the VPN's, the tailnet's), or
 * one of the configured addresses (`PUBLIC_URL`, the hub sign-in's public name). The same rule as Hub's and
 * TaskIndex's:
 * - an agent's bearer (a ContentOps token or a hub key) is never asked: no browser sends one by itself;
 * - a request with neither `Origin` nor `Sec-Fetch-Site` is not a browser's (a script, `ops.js`) and passes;
 * - `Origin: null`, another site's origin, and a cross-site `Sec-Fetch-Site` without `Origin` are refused.
 * The name is compared without the port: nginx passes `Host` without it (`$host`), and a port of the same name is
 * no other site.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface OriginRequest {
  method: string
  headers: IncomingHttpHeaders
  /** The name the request came to, without the port (Fastify `request.hostname`). */
  hostname: string
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The refusal of a change from another site's page, or null. */
export function originRefusal(
  request: OriginRequest,
  allowedOrigins: readonly string[],
): ApiProblem | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null
  if (/^bearer\s+\S/i.test(single(request.headers.authorization) ?? '')) return null
  const origin = single(request.headers.origin)
  const fetchSite = single(request.headers['sec-fetch-site'])
  if (origin === undefined) {
    if (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none') return null
    return refused()
  }
  const name = hostnameOf(origin)
  if (name === null) return refused()
  if (name === request.hostname.toLowerCase()) return null
  if (allowedOrigins.some((allowed) => hostnameOf(allowed) === name)) return null
  return refused()
}

function refused(): ApiProblem {
  return new ApiProblem('forbidden', 'Изменение пришло со страницы другого сайта и не принято')
}
