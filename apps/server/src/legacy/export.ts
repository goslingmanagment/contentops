import type { Db } from '@contentops/db'
import { planMarkdown } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import type { ImportReport } from './parse'

/**
 * The report of an import work as Markdown (PLAN этап 3: the dry run is an artifact of the
 * stage): the given work of the model, or its latest finished dry run. Only by the operator's
 * command — it holds real names and stays out of git.
 */
export async function importReportMarkdown(
  db: Db,
  model: string,
  workId: string | null,
): Promise<string> {
  const { rows } = await db.execute<{ report: ImportReport | null }>(sql`
    SELECT w.report FROM work_operations w JOIN models m ON m.id = w.model_id
     WHERE m.code = ${model} AND w.kind = 'import_parse' AND w.state = 'succeeded'
       AND (${workId}::uuid IS NULL AND w.dataset = 'plan' OR w.id = ${workId}::uuid)
     ORDER BY w.finished_at DESC LIMIT 1`)
  const report = rows[0]?.report
  if (!report) {
    throw new Error(
      workId
        ? `нет готовой работы импорта ${workId}`
        : `у модели ${model} нет готового сухого прогона`,
    )
  }
  return planMarkdown(report)
}
