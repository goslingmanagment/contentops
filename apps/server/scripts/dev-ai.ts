// Fake markup providers for `DEV_FAKE_AI=1 pnpm dev:server` (SPEC §12.0: external systems are
// fake servers in development too; nothing here reaches OpenAI or Anthropic): both APIs on one
// port, a valid answer for every stage, a refusal for the customs (CUS) — so the card shows
// «черновик · ИИ» on a PPV and «не удалось · разметить вручную» on a CUS. With `DATABASE_URL`
// it also puts the markup of the objects whose frames are ready, as `ops.js annotation run`
// would. Started by `dev-stack.mjs`; prints `ready <url>` when it listens.
import { createDb, createPool, enqueueWork } from '@contentops/db'
import { FakeProvider } from '@contentops/vision/testing'
import { sql } from 'drizzle-orm'

const PORT = Number(process.env.DEV_AI_PORT ?? '54333')

const fake = await new FakeProvider({
  port: PORT,
  decide: (request) => (request.context?.type === 'CUS' ? 'refuse' : undefined),
}).start()
console.log(`ready ${fake.url}`)

const url = process.env.DATABASE_URL
if (url) {
  const db = createDb(createPool(url, { max: 2, applicationName: 'dev-ai' }))
  const queue = async () => {
    const { rows } = await db.execute<{ model_id: string; id: string; type: string }>(sql`
      SELECT i.model_id, i.id, i.type FROM content_items i
        JOIN models m ON m.id = i.model_id AND m.code = 'lora'
       WHERE i.type IN ('PPV', 'CUS', 'FYP') AND i.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM item_memberships im
             JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
             JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
             JOIN rendition_generations g ON g.master_sha256 = v.master_sha256
                                         AND g.kind = 'frames' AND g.state = 'ready' AND g.is_active
            WHERE im.model_id = i.model_id AND im.item_id = i.id AND im.role = 'master'
              AND im.removed_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM work_operations w
                          WHERE w.kind = 'annotate' AND w.scope = i.id::text)
       ORDER BY i.type, i.number LIMIT 6`)
    // As `enqueueAnnotation` puts them: the stages of the type, by the routes the stand set.
    for (const row of rows) {
      const stages = row.type === 'PPV' ? ['observe', 'aggregate', 'texts'] : ['observe', 'aggregate']
      await enqueueWork(db, {
        modelId: row.model_id,
        kind: 'annotate',
        workKey: `annotate:${row.id}:${stages.join('+')}:dev`,
        scope: row.id,
        dataset: 'routine',
        priority: -10,
        checkpoint: { plan: { stages, probe: null } },
      })
    }
  }
  setInterval(() => void queue().catch((error: unknown) => console.error('dev-ai', error)), 10_000)
}
