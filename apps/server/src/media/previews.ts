import type { MediaPreview } from '@contentops/contracts/domain/common'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { renditionUrl } from '../catalog/entries'
import type { ModelScope } from '../context'

/**
 * What the viewer plays or shows of a file (SPEC §9.3, DESIGN §3.5): the browser copies of the
 * master's active generations — `preview.mp4` and `poster.webp` of a video, `preview-2048.webp`
 * of a photo — or, before a draft has its master, the ones built from its source (§6.1). A file
 * without its preview says whether a build is queued or running, and its share.
 */

export interface PreviewInput {
  media: 'video' | 'image'
  /** SHA-256 of the master, hex; `null` for a draft before its master is verified. */
  master: string | null
  /** SHA-256 of the source bytes, hex: the first previews of a draft are built from them. */
  source: string | null
}

type Kind = 'preview' | 'poster' | 'preview2048'
const NAME: Record<Kind, string> = {
  preview: 'preview.mp4',
  poster: 'poster.webp',
  preview2048: 'preview-2048.webp',
}

type Generations = Map<string, Partial<Record<Kind, string>>>

const hexList = (values: readonly string[]) =>
  sql`(SELECT decode(h, 'hex') FROM unnest(${sql.param([...values])}::text[]) h)`

/** Active ready generations of masters by the master hash. */
async function ofMasters(q: Queryable, masters: readonly string[]): Promise<Generations> {
  const out: Generations = new Map()
  if (masters.length === 0) return out
  const { rows } = await q.execute<{ sha: string; kind: Kind; id: string }>(sql`
    SELECT encode(g.master_sha256, 'hex') AS sha, g.kind, g.id
      FROM rendition_generations g
     WHERE g.master_sha256 IN ${hexList(masters)}
       AND g.kind IN ('preview', 'poster', 'preview2048')
       AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped`)
  for (const row of rows) out.set(row.sha, { ...out.get(row.sha), [row.kind]: row.id })
  return out
}

/** The newest ready generations built from a source, bound to a master or not yet. */
async function ofSources(q: Queryable, sources: readonly string[]): Promise<Generations> {
  const out: Generations = new Map()
  if (sources.length === 0) return out
  const { rows } = await q.execute<{ sha: string; kind: Kind; id: string }>(sql`
    SELECT DISTINCT ON (g.input_sha256, g.kind) encode(g.input_sha256, 'hex') AS sha, g.kind, g.id
      FROM rendition_generations g
     WHERE g.input_sha256 IN ${hexList(sources)}
       AND g.kind IN ('preview', 'poster', 'preview2048')
       AND g.state = 'ready' AND NOT g.meta_stripped
     ORDER BY g.input_sha256, g.kind, g.ready_at DESC`)
  for (const row of rows) out.set(row.sha, { ...out.get(row.sha), [row.kind]: row.id })
  return out
}

/** Unfinished `derive_*` works of the model by input hash, with their share. */
async function builds(
  q: Queryable,
  modelId: string,
  inputs: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (inputs.length === 0) return out
  const { rows } = await q.execute<{ sha: string; num: string | null; den: string | null }>(sql`
    SELECT encode(w.input_sha256, 'hex') AS sha, w.progress_num::text AS num,
           w.progress_den::text AS den
      FROM work_operations w
     WHERE w.model_id = ${modelId}::uuid AND w.kind IN ('derive_video', 'derive_image')
       AND w.state IN ('pending', 'running', 'retry_wait')
       AND w.input_sha256 IN ${hexList(inputs)}`)
  for (const row of rows) {
    const share =
      row.num !== null && row.den !== null && Number(row.den) > 0
        ? Math.min(1, Number(row.num) / Number(row.den))
        : null
    out.set(row.sha, share ?? out.get(row.sha) ?? null)
  }
  return out
}

/** The previews of the files, in their order. */
export async function mediaPreviews(
  q: Queryable,
  model: Pick<ModelScope, 'id' | 'code'>,
  files: readonly PreviewInput[],
): Promise<MediaPreview[]> {
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((value): value is string => value !== null)),
  ]
  const byMaster = await ofMasters(q, unique(files.map((file) => file.master)))
  const bySource = await ofSources(
    q,
    unique(files.filter((file) => !hasPreview(byMaster, file)).map((file) => file.source)),
  )
  const found = (file: PreviewInput) =>
    (file.master ? byMaster.get(file.master) : undefined) ??
    (file.source ? bySource.get(file.source) : undefined)
  const missing = files.filter((file) => !mainOf(file, found(file)))
  const running = await builds(
    q,
    model.id,
    unique(missing.flatMap((file) => [file.master, file.source])),
  )
  return files.map((file) => {
    const generations = found(file)
    const main = mainOf(file, generations)
    const poster = file.media === 'video' ? generations?.poster : undefined
    const share = [file.master, file.source].find((sha) => sha !== null && running.has(sha))
    const name = NAME[file.media === 'video' ? 'preview' : 'preview2048']
    return {
      url: main ? renditionUrl(model, main, name) : null,
      poster: poster ? renditionUrl(model, poster, NAME.poster) : null,
      building: main || !share ? null : { progress: running.get(share) ?? null },
    }
  })
}

function mainOf(
  file: PreviewInput,
  generations: Partial<Record<Kind, string>> | undefined,
): string | undefined {
  return file.media === 'video' ? generations?.preview : generations?.preview2048
}

function hasPreview(byMaster: Generations, file: PreviewInput): boolean {
  return file.master !== null && mainOf(file, byMaster.get(file.master)) !== undefined
}
