// A fake Agency Hub for `DEV_FAKE_HUB=1 pnpm dev:server` (SPEC §12.0: external systems are fake
// servers in development too; nothing here reaches a real Hub or a real page). It answers the
// agent API of ContentOps — datasets (empty), publication files, drafts with their checks,
// approve, cancel and the feed of changes — and moves publications the way Hub would:
// an approved one is handed to the platform's schedule after a few seconds. «Вышло» and
// «не вышло» are the developer's: `POST /__dev/publications/<id>/publish` or `/not-publish`.
// Started by `dev-stack.mjs`; prints `ready <url>` when it listens.
import type { LoggedRequest, Reply } from '@contentops/hub/testing'
import { FakeHub } from '@contentops/hub/testing'

const PORT = Number(process.env.DEV_HUB_PORT ?? '54331')
const KEY = process.env.DEV_HUB_KEY ?? 'dev-hub-key'
/** How long Hub keeps an approved publication before handing it to the platform. */
const HAND_OFF_MS = Number(process.env.DEV_HUB_HAND_OFF_MS ?? '8000')

class DevHub extends FakeHub {
  protected override endpointOf(method: string, path: string): string {
    if (method === 'POST' && path.startsWith('/__dev/')) return 'dev'
    return super.endpointOf(method, path)
  }

  protected override handle(req: LoggedRequest): Reply {
    if (req.endpoint !== 'dev') return super.handle(req)
    const match = /^\/__dev\/publications\/(\d+)\/(publish|not-publish|unknown)$/.exec(req.path)
    if (!match) return { status: 404, body: { error: 'not_found' } }
    const id = Number(match[1])
    try {
      const p = this.publication(id)
      if (p.status === 'approved') this.handToPlatform(id)
      if (match[2] === 'publish') this.publish(id, p.kind === 'vault_album' ? `album-${id}` : `post-${id}`)
      else if (match[2] === 'not-publish') this.notPublish(id, 'upload_failed')
      else this.markUnknown(id)
      return { status: 200, body: { id, status: this.publication(id).status } }
    } catch (error) {
      return { status: 409, body: { error: (error as Error).message } }
    }
  }
}

const pages = [
  { pageLabel: 'lora-1', platform: 'fansly' as const, modelSlug: 'lora' },
  { pageLabel: 'lora-2', platform: 'fansly' as const, modelSlug: 'lora' },
  { pageLabel: 'lora-3', platform: 'fansly' as const, modelSlug: 'lora' },
  { pageLabel: 'lora-of', platform: 'onlyfans' as const, modelSlug: 'lora' },
  { pageLabel: 'lora-vip-of', platform: 'onlyfans' as const, modelSlug: 'lora' },
  { pageLabel: 'ari-1', platform: 'fansly' as const, modelSlug: 'ari' },
]
const hub = new DevHub({ key: KEY, pages, now: new Date(), maxFileBytes: 2_000_000_000 })

// Hub's own clock follows the real one; approved publications go to the schedule.
const approvedAt = new Map<number, number>()
setInterval(() => {
  hub.setNow(new Date())
  for (const p of hub.publications.values()) {
    if (p.status !== 'approved') continue
    const since = approvedAt.get(p.id) ?? Date.now()
    approvedAt.set(p.id, since)
    if (Date.now() - since >= HAND_OFF_MS) hub.handToPlatform(p.id)
  }
}, 1_000).unref()

await hub.start()
// The fake listens on a random port; a stable one is proxied for the stack's environment.
const { createServer, request } = await import('node:http')
const target = new URL(hub.url)
createServer((req, res) => {
  const forward = request(
    { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  forward.on('error', () => {
    res.writeHead(502)
    res.end()
  })
  req.pipe(forward)
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`ready http://127.0.0.1:${PORT}\n`)
})
