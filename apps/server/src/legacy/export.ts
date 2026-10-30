import type { Db } from '@contentops/db'
import { planMarkdown } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import type { ImportReport } from './parse'
import { type ReconcileReport, reconcileMarkdown } from './reconcile'

/**
 * The report of an import work as Markdown (PLAN этап 3: the dry run is an artifact of the
 * stage): the given work of the model, or its latest finished dry run (`plan`) or
 * reconciliation (`reconcile`). Only by the operator's command — it holds real names and stays
 * out of git.
 */
export async function importReportMarkdown(
  db: Db,
  model: string,
  workId: string | null,
): Promise<string> {
  const latest = workId === null || workId === 'plan' || workId === 'reconcile'
  const dataset = workId === 'reconcile' ? 'reconcile' : 'plan'
  const id = latest ? null : workId
  const { rows } = await db.execute<{ report: (ImportReport | ReconcileReport) | null }>(sql`
    SELECT w.report FROM work_operations w JOIN models m ON m.id = w.model_id
     WHERE m.code = ${model} AND w.kind = 'import_parse' AND w.state = 'succeeded'
       AND (${id}::uuid IS NULL AND w.dataset = ${dataset} OR w.id = ${id}::uuid)
     ORDER BY w.finished_at DESC LIMIT 1`)
  const report = rows[0]?.report
  if (!report) {
    throw new Error(
      workId
        ? `нет готовой работы импорта ${workId}`
        : `у модели ${model} нет готового сухого прогона`,
    )
  }
  if (report.mode === 'reconcile') return reconcileMarkdown(report)
  if (report.mode === 'plan' || report.mode === 'parse') return planMarkdown(report)
  return `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}
