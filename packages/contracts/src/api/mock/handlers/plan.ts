import { instantMs, isoWeekOf, weekDates } from '../../../clock'
import type { PlanDownloadCommand } from '../../../commands/plan'
import type { MarkKind } from '../../../domain/placement'
import { accountOf, evaluateRow, type FactsContext, hubCoverage } from '../../../fixtures/facts'
import { nameOf } from '../../../fixtures/people'
import type { ModelWorld, PlanRowRecord } from '../../../fixtures/world-types'
import { formatDate, lowerFirst, pastVerb, plural } from '../../../format'
import { markButtonKind } from '../../../placement'
import { versionTag } from '../../headers'
import { planRoutes } from '../../routes/plan'
import { forbidden, notFound, rule } from '../domain-error'
import { type BoundRoute, bind, todayOf } from '../handler'
import { registerSample } from '../sample-files'
import type { MockState } from '../state'
import { memberLine, recordDelivery, rowOptions } from '../views/delivery'
import { manifestOf, planDay, planRowView, planWeek } from '../views/plan'
import { checkLine } from '../views/plan-warnings'
import { actorSays } from './actor-says'
import { placementsChanged } from './model-records'
import { assertOpen, buildRow, insertRow, rowOf, rowProblem, trackForRow } from './plan-records'

/** Plan commands (DESIGN §4.11–4.14): put, mark, confirm, cancel, move, releases, norms. */

/** A just-created row may be deleted by its author within 6 s (DESIGN §3.8, §10.8). */
const UNDO_WINDOW_MS = 6_000

function itemLabel(row: PlanRowRecord): string {
  return row.item_id ?? 'строку под монтаж'
}

function mark(
  state: MockState,
  context: FactsContext,
  row: PlanRowRecord,
  kind: MarkKind,
  statedAt: string | null,
) {
  assertOpen(row)
  if (row.mark?.kind === kind) throw rule('row_marked', 'Не выполнено: строка уже отмечена')
  row.mark = {
    kind,
    at: state.clock.now(),
    by: state.principal.id,
    stated_occurred_at: statedAt,
    for_current_manifest: true,
  }
  row.version += 1
  placementsChanged(context.model)
}

function markConfirm(
  state: MockState,
  context: FactsContext,
  row: PlanRowRecord,
  statedAt: string | null,
) {
  assertOpen(row)
  const account = accountOf(context.model, row.account)
  const hub = hubCoverage(context, row.account, row.surface)
  // Подтвердить вручную можно там, где Hub не проверяет, и там, где он не смог проверить.
  const unverified = evaluateRow(context, row).level === 'cannot_verify'
  if (markButtonKind(account.platform, row.surface, hub.state) !== 'mark_confirm' && !unverified) {
    throw rule('invalid_request', 'Здесь подтверждает Hub — нужна обычная отметка')
  }
  const now = state.clock.now()
  row.mark = {
    kind: 'posted',
    at: now,
    by: state.principal.id,
    stated_occurred_at: statedAt,
    for_current_manifest: true,
  }
  row.version += 1
  trackForRow(context.model, row).evidence.push({
    id: `e-${row.id}-report-${row.version}`,
    kind: 'manual_confirm',
    recorded_at: now,
    by: nameOf(state.principal.id, state.world.people),
    basis: 'report',
  })
  placementsChanged(context.model)
}

/**
 * Rows a plan archive carries: ready platform copies in scope, one page or all; with «Мои»
 * only the rows the person posts.
 */
function archiveRows(
  model: ModelWorld,
  command: PlanDownloadCommand,
  personId: string,
): PlanRowRecord[] {
  const inScope = (row: PlanRowRecord) => {
    if (row.cancelled || (command.account && row.account !== command.account)) return false
    if (command.mine && row.assignee !== personId) return false
    if (command.scope === 'day') return row.date === command.date
    if (command.scope === 'week') return isoWeekOf(row.date) === command.week
    return row.release_id === command.release_id
  }
  return [...model.plan_rows.values()]
    .filter((row) => inScope(row) && row.copy?.state === 'ready')
    .sort((left, right) =>
      `${left.date} ${left.time ?? ''} ${left.account}`.localeCompare(
        `${right.date} ${right.time ?? ''} ${right.account}`,
      ),
    )
}

function archiveSize(rows: readonly PlanRowRecord[]): number {
  return rows.reduce((sum, row) => sum + (row.copy?.state === 'ready' ? row.copy.size_bytes : 0), 0)
}

/** «21.09–27.09». */
function weekSpan(week: string, today: string): string {
  const days = weekDates(week)
  return `${formatDate(days[0] ?? '', today)}–${formatDate(days.at(-1) ?? '', today)}`
}

/**
 * Paths inside a plan archive: every file of each row by page code, and by day for a week;
 * a row's photos lie as separate files in upload order, not as a ZIP inside the ZIP.
 */
function archiveMembers(
  facts: FactsContext,
  command: PlanDownloadCommand,
  rows: readonly PlanRowRecord[],
): string[] {
  return rows.flatMap((row) => {
    const record = row.item_id ? facts.model.items.get(row.item_id) : undefined
    if (!record) return []
    const folder = command.scope === 'week' ? `${row.date}/${row.account}` : row.account
    const options = rowOptions(facts.model, row)
    return (manifestOf(facts, row)?.files ?? []).flatMap((file) =>
      recordDelivery(record, file.key, options).files.map(
        (member) => `${folder}/${memberLine(member)}`,
      ),
    )
  })
}

export function planHandlers(): BoundRoute[] {
  return [
    bind(planRoutes.day, 'read', ({ facts, query, state }) =>
      planDay(
        facts(),
        query.date,
        query.mine ? state.principal.id : null,
        query.cancelled ?? false,
      ),
    ),
    bind(planRoutes.week, 'read', ({ facts, query }) => planWeek(facts(), query.week)),
    bind(
      planRoutes.row,
      'read',
      ({ facts, params }) => planRowView(facts(), rowOf(facts().model, params.row)),
      {
        etag: (body) => versionTag(body.version),
      },
    ),
    bind(planRoutes.createRows, 'staff', (context) => {
      const facts = context.facts()
      const rejected = context.body.rows.flatMap((input, index) => {
        const problem = rowProblem(facts.model, input)
        return problem ? [{ index, ...problem }] : []
      })
      if (rejected.length > 0) return { created: false, rows: [], rejected }
      const rows = context.body.rows.map((input) =>
        insertRow(facts.model, buildRow(context.state, facts.model, input)),
      )
      const views = rows.map((row) =>
        planRowView(facts, row, context.query.dry_run ? 'preview' : 'row'),
      )
      if (context.query.dry_run) {
        for (const row of rows) facts.model.plan_rows.delete(row.id)
        return { created: false, rows: views, rejected: [] }
      }
      context.log({
        area: 'plan',
        action: 'plan.create',
        phrase: `${actorSays(context.state, 'поставил')} ${rows.length} ${plural(rows.length, ['строку', 'строки', 'строк'])} в план`,
      })
      return { created: true, rows: views, rejected: [] }
    }),
    bind(planRoutes.checkRow, 'read', (context) => {
      const facts = context.facts()
      const problem = rowProblem(facts.model, context.body)
      const candidate = {
        row_id: null,
        ...context.body,
        montage_from: context.body.awaiting_montage?.from_item ?? null,
      }
      if (problem) {
        return {
          tone: 'attention',
          text: problem.text,
          page_text: lowerFirst(problem.text),
          blocked: true,
          warnings: [],
        }
      }
      return { ...checkLine(facts, candidate), blocked: false }
    }),
    bind(planRoutes.undoCreate, 'staff', (context) => {
      const model = context.model()
      const row = rowOf(model, context.params.row)
      const age = instantMs(context.state.clock.now()) - instantMs(row.created_at)
      const fresh = row.created_by === context.state.principal.id && age <= UNDO_WINDOW_MS
      if (!fresh || row.mark || row.downloaded) {
        throw rule('undo_expired', 'Строку уже нельзя удалить — её можно отменить')
      }
      model.plan_rows.delete(row.id)
      model.tracks = model.tracks.filter((track) => track.plan_row_id !== row.id)
      placementsChanged(model)
      return { ok: true }
    }),
    bind(planRoutes.updateRow, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      context.requireVersion(row.version)
      const { body } = context
      if (body.note !== undefined) row.note = body.note
      if (body.assignee !== undefined) row.assignee = body.assignee
      if (body.replace_manifest) {
        row.has_newer_version = false
        if (row.mark) row.mark.for_current_manifest = false
      }
      row.version += 1
      return planRowView(facts, row)
    }),
    bind(planRoutes.mark, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      mark(context.state, facts, row, context.body.kind, context.body.stated_occurred_at)
      const how = context.body.kind === 'scheduled' ? ': в планировщике' : ''
      context.log({
        area: 'plan',
        action: 'plan.mark',
        phrase: `${actorSays(context.state, 'отметил')} ${itemLabel(row)} на ${accountOf(facts.model, row.account).label}${how}`,
        item_id: row.item_id,
      })
      return planRowView(facts, row)
    }),
    bind(planRoutes.markConfirm, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      markConfirm(context.state, facts, row, context.body.stated_occurred_at)
      context.log({
        area: 'plan',
        action: 'plan.mark_confirm',
        phrase: `${actorSays(context.state, 'отметил')} и ${pastVerb('подтвердил', context.state.principal.gender)} ${itemLabel(row)} на ${accountOf(facts.model, row.account).label}`,
        item_id: row.item_id,
      })
      return planRowView(facts, row)
    }),
    bind(planRoutes.unmark, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      if (!row.mark) throw rule('row_not_marked', 'Не выполнено: строка не отмечена')
      if (row.mark.by !== context.state.principal.id && context.state.principal.role !== 'owner') {
        throw forbidden('Снять отметку может тот, кто отметил, и владелец')
      }
      row.mark = null
      row.version += 1
      const track = facts.model.tracks.find((candidate) => candidate.plan_row_id === row.id)
      if (track)
        track.evidence = track.evidence.filter(
          (evidence) => evidence.kind !== 'manual_confirm' || evidence.basis !== 'report',
        )
      placementsChanged(facts.model)
      context.log({
        area: 'plan',
        action: 'plan.unmark',
        phrase: `${actorSays(context.state, 'снял')} отметку ${itemLabel(row)}`,
        item_id: row.item_id,
      })
      return planRowView(facts, row)
    }),
    bind(planRoutes.cancel, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      // Причина выбирается чипом в полоске уже после отмены (DESIGN §3.8): повтор с причиной
      // её уточняет, а отменить строку второй раз нельзя.
      if (row.cancelled && context.body.reason !== null) {
        row.cancelled.reason = context.body.reason
        row.version += 1
        return planRowView(facts, row)
      }
      assertOpen(row)
      if (row.mark) throw rule('row_marked', 'Не выполнено: сначала снимите отметку')
      row.cancelled = {
        at: context.state.clock.now(),
        by: context.state.principal.id,
        reason: context.body.reason,
      }
      row.version += 1
      placementsChanged(facts.model)
      context.log({
        area: 'plan',
        action: 'plan.cancel',
        phrase: `${actorSays(context.state, 'отменил')} строку ${itemLabel(row)}`,
        item_id: row.item_id,
      })
      return planRowView(facts, row)
    }),
    bind(planRoutes.move, 'staff', (context) => {
      const facts = context.facts()
      const row = rowOf(facts.model, context.params.row)
      context.requireVersion(row.version)
      assertOpen(row)
      if (row.mark)
        throw rule('row_marked', 'Отмеченную строку перенести нельзя — сначала снимите отметку')
      row.date = context.body.date
      row.time = context.body.time
      row.account = context.body.account
      row.version += 1
      placementsChanged(facts.model)
      context.log({
        area: 'plan',
        action: 'plan.move',
        phrase: `${actorSays(context.state, 'переставил')} ${itemLabel(row)} на ${formatDate(row.date, todayOf(context.state))}`,
        item_id: row.item_id,
      })
      return planRowView(facts, row)
    }),
    bind(planRoutes.markMany, 'staff', (context) => {
      const facts = context.facts()
      const results = context.body.row_ids.map((id) => {
        const row = facts.model.plan_rows.get(id)
        if (!row) return { id, ok: false, code: 'not_found' }
        if (row.cancelled) return { id, ok: false, code: 'row_cancelled' }
        if (row.mark?.kind === context.body.kind) return { id, ok: false, code: 'row_marked' }
        mark(context.state, facts, row, context.body.kind, null)
        return { id, ok: true, code: null }
      })
      const done = results.filter((result) => result.ok).length
      context.log({
        area: 'plan',
        action: 'plan.mark',
        phrase: `${actorSays(context.state, 'отметил')} ${done} ${plural(done, ['строку', 'строки', 'строк'])}${context.body.kind === 'scheduled' ? ': в планировщике' : ''}`,
      })
      return { results }
    }),
    bind(planRoutes.markConfirmMany, 'staff', (context) => {
      const facts = context.facts()
      const results = context.body.row_ids.map((id) => {
        const row = facts.model.plan_rows.get(id)
        if (!row) return { id, ok: false, code: 'not_found' }
        try {
          markConfirm(context.state, facts, row, null)
          return { id, ok: true, code: null }
        } catch {
          return { id, ok: false, code: 'invalid_request' }
        }
      })
      return { results }
    }),
    bind(planRoutes.createRelease, 'staff', (context) => {
      const facts = context.facts()
      const record = facts.model.items.get(context.body.item_id)
      if (!record) throw notFound(`${context.body.item_id} нет`)
      if (record.entry.type !== 'ppv') throw rule('invalid_request', 'Выпуск бывает только у PPV')
      const releaseId = `rel-${record.entry.id.toLowerCase()}-${facts.model.releases.length + 1}`
      const inputs = context.body.cells.map((cell) => ({
        item_id: record.entry.id,
        account: cell.account,
        surface: cell.surface,
        date: cell.date,
        time: cell.time,
        fyp_version: null,
        assignee: null,
        note: null,
        requires_new_upload: false,
        awaiting_montage: null,
        marked: null,
      }))
      const problems = inputs.flatMap((input) => rowProblem(facts.model, input) ?? [])
      if (problems.length > 0)
        throw rule('batch_rejected', `Не поставлено: ${problems[0]?.text ?? ''}`, { problems })
      const rows = inputs.map((input) =>
        insertRow(facts.model, buildRow(context.state, facts.model, input, releaseId)),
      )
      const date = context.body.cells.map((cell) => cell.date).sort()[0] ?? rows[0]?.date ?? ''
      facts.model.releases.push({ id: releaseId, item_id: record.entry.id, date })
      context.log({
        area: 'plan',
        action: 'plan.release',
        phrase: `${actorSays(context.state, 'поставил')} выпуск ${record.entry.id}: ${rows.length} ${plural(rows.length, ['строка', 'строки', 'строк'])}`,
        item_id: record.entry.id,
      })
      return {
        release: {
          id: releaseId,
          item_id: record.entry.id,
          date,
          row_ids: rows.map((row) => row.id),
          done: 0,
          accounts: new Set(rows.map((row) => row.account)).size,
        },
        rows: rows.map((row) => planRowView(facts, row)),
      }
    }),
    bind(planRoutes.download, 'staff', (context) => {
      const model = context.model()
      const { body } = context
      const scopeLabel = { day: 'дня', release: 'выпуска', week: 'недели' }[body.scope]
      const page = body.account
        ? accountOf(model, body.account).label
        : body.mine
          ? 'мои строки'
          : 'все страницы'
      const name = `${model.model.code}_${body.scope}_${body.date ?? body.week ?? body.release_id ?? ''}${body.account ? `_${body.account}` : ''}.zip`
      const rows = archiveRows(model, body, context.state.principal.id)
      const url = `/api/v1/${model.model.code}/downloads/${name}`
      const when =
        body.scope === 'day'
          ? `день ${formatDate(body.date ?? '', todayOf(context.state))}`
          : body.scope === 'week' && body.week
            ? `неделя ${weekSpan(body.week, todayOf(context.state))}`
            : `выпуск ${body.release_id ?? ''}`
      registerSample(context.state, url, {
        file_name: name,
        kind: `Архив ${scopeLabel} · ${page} · копии для платформы`,
        size_bytes: archiveSize(rows),
        source: `План · ${when}`,
        meta_stripped: body.strip_metadata,
        members: archiveMembers(context.facts(), body, rows),
      })
      const operation = context.state.operations.start({
        model: model.model.code,
        kind:
          body.scope === 'day' ? 'zip_day' : body.scope === 'release' ? 'zip_release' : 'zip_week',
        label: `Архив ${scopeLabel} собирается · ${page}`,
        done_label: `Архив ${scopeLabel} готов · ${page}`,
        result: { download_url: url, file_name: name, size_bytes: archiveSize(rows) },
      })
      return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
    }),
    bind(
      planRoutes.norm,
      'read',
      ({ model, params }) => {
        const norm = model().norms.get(params.account)
        if (!norm) throw notFound('У страницы нет нормы')
        return norm
      },
      { etag: (body) => versionTag(body.version) },
    ),
    bind(planRoutes.updateNorm, 'staff', (context) => {
      const model = context.model()
      const norm = model.norms.get(context.params.account)
      if (!norm) throw notFound('У страницы нет нормы')
      context.requireVersion(norm.version)
      const updated = { ...norm, ...context.body, version: norm.version + 1 }
      model.norms.set(norm.account, updated)
      context.log({
        area: 'plan',
        action: 'plan.norm',
        phrase: `${actorSays(context.state, 'изменил')} норму ${accountOf(model, norm.account).label}`,
      })
      return updated
    }),
  ]
}
