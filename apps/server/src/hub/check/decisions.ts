import { randomUUID } from 'node:crypto'
import type { PostSurface } from '@contentops/contracts/commands/check'
import { CHECK_KIND_BY_LEVEL } from '@contentops/contracts/domain/check'
import type { PlacementVerdict } from '@contentops/contracts/domain/placement'
import { logAction, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { findItem } from '../../catalog/ids'
import type { Actor, ModelScope } from '../../context'
import { ApiProblem } from '../../errors'
import { type EvidenceRecord, type RowRecord, rowById, standingEvidence } from '../../plan/records'
import { evaluatePlacementRecord, evaluateRow, loadState, type PlanState } from '../../plan/state'
import {
  type HubFile,
  type HubPostFacts,
  loadPosts,
  loadRows,
  type Page,
  pageOf,
  type RowFile,
} from '../match/load'
import { type FileMatch, hintSurface, hubSurface, pairFiles } from '../match/rules'
import {
  addEvidence,
  bindAssets,
  lockPage,
  publicationPlacement,
  rowPlacement,
  surfaceIdOf,
} from '../match/write'
import {
  allCases,
  type CaseRef,
  checkModel,
  openQuestions,
  parseCase,
  postCase,
  postVerdict,
  rowCaseId,
} from './cases'

/**
 * Decisions of «Сверить» (DESIGN §4.15, SPEC §7 «Точное вручную»): «Это оно» on one pair with the
 * basis «осмотренная пара», «Не то» (`manual_reject`, never exact), «Привязать…», «Не наше»,
 * «Отменить» and «Подтвердить однозначные» (Fansly only, one to one, within tolerances). A
 * decision of an agent is marked «подтверждено агентом» by its author. One decision is one
 * `decision_id` on every row it wrote, so «Отменить» takes back all of them.
 */

const fail = (text: string): never => {
  throw new ApiProblem('invalid_request', text)
}

const resolved = (): never => {
  throw new ApiProblem('case_resolved', 'Случай уже решён')
}

interface Decided {
  case_id: string
  verdict: PlacementVerdict
}

interface RowCase {
  ref: CaseRef & { kind: 'row' }
  row: RowRecord
  page: Page
  state: PlanState
}

interface PostCaseOpen {
  ref: CaseRef & { kind: 'post' }
  post: HubPostFacts
  page: Page
  state: PlanState
  kind: 'unplanned' | 'surface'
  itemId: string | null
}

async function postOf(
  tx: Tx,
  model: ModelScope,
  id: string,
): Promise<{ post: HubPostFacts; page: Page }> {
  const { rows } = await tx.execute<{ account_id: string }>(sql`
    SELECT account_id FROM hub_posts WHERE model_id = ${model.id}::uuid AND id = ${id}::uuid`)
  const accountId = rows[0]?.account_id
  const page = accountId ? await pageOf(tx, accountId) : null
  if (!page) throw new ApiProblem('not_found', 'Такого случая сверки нет')
  const [post] = await loadPosts(tx, page, sql`p.id = ${id}::uuid`)
  if (!post) throw new ApiProblem('not_found', 'Такого случая сверки нет')
  return { post, page }
}

/** The case as it stands now, under the page's lock: a closed case is 422. */
async function openCase(
  tx: Tx,
  model: ModelScope,
  caseId: string,
): Promise<RowCase | PostCaseOpen> {
  const ref = parseCase(caseId)
  if (ref.kind === 'row') {
    const row = await rowById(tx, model, ref.id, true)
    const page = await pageOf(tx, row.account_id)
    if (!page) throw new ApiProblem('not_found', 'Такого случая сверки нет')
    await lockPage(tx, page.accountId)
    const state = await loadState(tx, model)
    const fresh = state.rows.find((one) => one.id === row.id) as RowRecord
    if (!CHECK_KIND_BY_LEVEL[evaluateRow(state, fresh).level]) resolved()
    return { ref, row: fresh, page, state }
  }
  const { post, page } = await postOf(tx, model, ref.id)
  await lockPage(tx, page.accountId)
  const state = await loadState(tx, model)
  const cases = await checkModel(tx, state)
  const found = cases.postCases.find((one) => one.post.id === post.id)
  if (!found || !postCase(cases, found)) resolved()
  return {
    ref,
    post,
    page,
    state,
    kind: (found as NonNullable<typeof found>).kind,
    itemId: (found as NonNullable<typeof found>).itemId,
  }
}

async function verdictOf(
  tx: Tx,
  model: ModelScope,
  ref: CaseRef,
  page: Page,
): Promise<PlacementVerdict> {
  const state = await loadState(tx, model)
  if (ref.kind === 'row') {
    const row = state.rows.find((one) => one.id === ref.id) as RowRecord
    return evaluateRow(state, row)
  }
  const cases = await checkModel(tx, state)
  const open = cases.postCases.find((one) => one.post.id === ref.id)
  if (open) return postVerdict(cases, open)
  const { rows } = await tx.execute<{ post_ref: string }>(sql`
    SELECT post_ref FROM hub_posts WHERE model_id = ${model.id}::uuid AND id = ${ref.id}::uuid`)
  const placement = state.placements.find(
    (one) => one.account_id === page.accountId && one.external_post_ref === rows[0]?.post_ref,
  )
  if (!placement) throw new ApiProblem('not_found', 'Такого случая сверки нет')
  return evaluatePlacementRecord(state, placement)
}

/** Projection of the post's files: which version each one is by name (schema §9.6). */
function projected(post: HubPostFacts): Map<string, FileMatch> {
  return new Map(
    post.mains.map((file) => [
      file.attachmentId,
      {
        strength: file.matchStrength === 'exact' ? 'exact' : 'none',
        versionId: file.matchedVersionId,
        assetId: null,
        itemId: null,
        receiptEntryId: file.receiptEntryId,
        issuedMs: null,
        nameOnly: false,
      } satisfies FileMatch,
    ]),
  )
}

/** The pairs «версия — media ID» a confirmation stands for (SPEC §7): reused on later posts. */
function pairsOf(
  ours: readonly RowFile[],
  theirs: readonly HubFile[],
  exact: Map<string, FileMatch>,
) {
  return pairFiles(ours, theirs, exact).map(({ version, file }) => ({
    version_id: version.versionId,
    asset_id: version.assetId,
    media_ref: file.mediaRef,
    duration_ms: file.durationMs,
    width: file.width,
    height: file.height,
  }))
}

async function rowMains(tx: Tx, page: Page, rowId: string): Promise<RowFile[]> {
  const [row] = await loadRows(tx, page, sql`r.id = ${rowId}::uuid`)
  return row?.mains ?? []
}

/** Current main files of an object: what «Привязать…» pairs the post's files with. */
async function itemMains(tx: Tx, page: Page, itemId: string): Promise<RowFile[]> {
  const { rows } = await tx.execute<{
    asset_id: string
    version_id: string
    role: string
    media_kind: 'video' | 'image'
    duration_ms: string | null
    width: number | null
    height: number | null
  }>(sql`
    SELECT a.id AS asset_id, a.current_version_id AS version_id, m.role, a.media_kind,
           v.duration_ms::text AS duration_ms, v.width, v.height
      FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
     WHERE m.model_id = ${page.modelId}::uuid AND m.item_id = ${itemId}::uuid AND m.kind = 'owned'
       AND m.removed_at IS NULL AND m.role NOT IN ('teaser', 'thumb', 'cap', 'raw')
     ORDER BY m.display_position NULLS LAST, m.ordinal NULLS LAST`)
  return rows.map((row) => ({
    assetId: row.asset_id,
    versionId: row.version_id,
    role: row.role,
    isVideo: row.media_kind === 'video',
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    width: row.width,
    height: row.height,
  }))
}

interface DecisionContext {
  tx: Tx
  model: ModelScope
  actor: Actor
  decision: string
}

async function reject(
  ctx: DecisionContext,
  page: Page,
  target: EvidenceRecord,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await addEvidence(ctx.tx, page, {
    placementId: target.placement_id,
    source: 'manual',
    kind: 'manual_reject',
    strength: null,
    payload: {
      decision_id: ctx.decision,
      // The candidate this «Не то» answers; not `corrects_id`: an answer taken back with
      // «Отменить» may be given again, and a row has one correction only (schema §9.2).
      rejects: target.id,
      plan_row_id: target.payload.plan_row_id ?? null,
      post_ref: target.payload.post_ref ?? null,
      post_id: target.payload.post_id ?? null,
      ...extra,
    },
    recordedBy: ctx.actor.id,
    dedupKey: `reject:${target.id}:${ctx.decision}`,
  })
}

/** The other rows' open candidates of a post a person has just tied to one row. */
async function rejectElsewhere(
  ctx: DecisionContext,
  state: PlanState,
  page: Page,
  postRef: string,
  rowId: string,
) {
  for (const row of state.rows) {
    if (row.id === rowId || row.account_id !== page.accountId) continue
    for (const open of openQuestions(state, row.id)) {
      if (open.payload.post_ref === postRef) await reject(ctx, page, open, { reason: 'taken' })
    }
  }
}

async function confirmRow(
  ctx: DecisionContext,
  found: RowCase,
  evidenceId: string | null,
  surface: PostSurface | undefined,
): Promise<void> {
  const { row, page, state } = found
  const open = openQuestions(state, row.id)
  if (open.length === 0)
    fail('Здесь нечего подтверждать: выберите «Залить заново» или отметьте строку')
  if (open.length > 1 && !evidenceId) fail('Выберите вариант')
  const chosen = evidenceId ? open.find((one) => one.id === evidenceId) : open[0]
  if (!chosen) fail('Такого варианта у случая нет')
  const target = chosen as EvidenceRecord
  const kind = target.payload.kind
  if (kind === 'surface' && !surface) fail('Выберите: стена или фуп')
  if (kind !== 'surface' && surface) fail('Куда вышел пост, уже известно')
  const mains = await rowMains(ctx.tx, page, row.id)
  const base = {
    basis: 'inspected_pair',
    decision_id: ctx.decision,
    plan_row_id: row.id,
    evidence_id: target.id,
    post_ref: target.payload.post_ref ?? null,
    post_id: target.payload.post_id ?? null,
  }
  if (kind === 'vault' || kind === 'stale') {
    // A vault file: the candidate already sits on the file's placement (album and media).
    const media = typeof target.external_ref === 'string' ? target.external_ref : null
    const file = mains.find((one) => one.versionId === target.matched_version_id) ?? mains[0]
    const pairs =
      file && media
        ? [
            {
              version_id: file.versionId,
              asset_id: file.assetId,
              media_ref: media,
              duration_ms: file.durationMs,
              width: file.width,
              height: file.height,
            },
          ]
        : []
    await addEvidence(ctx.tx, page, {
      placementId: target.placement_id,
      source: 'manual',
      kind: 'manual_confirm',
      strength: 'exact',
      payload: { ...base, pairs, old_file: kind === 'stale' },
      recordedBy: ctx.actor.id,
      dedupKey: `manual:${randomUUID()}`,
    })
    if (file) {
      await bindAssets(
        ctx.tx,
        page,
        target.placement_id,
        [{ ...file, strength: 'exact', mediaRef: media }],
        ctx.actor.id,
      )
    }
  } else {
    if (typeof target.payload.post_id !== 'string') fail('У варианта нет поста')
    const [post] = await loadPosts(ctx.tx, page, sql`p.id = ${target.payload.post_id}::uuid`)
    if (!post) fail('Пост этого варианта Hub больше не отдаёт')
    const theirs = post as HubPostFacts
    const pairs = pairsOf(mains, theirs.mains, projected(theirs))
    const answer = surface ?? (row.surface as PostSurface)
    if (answer === row.surface) {
      const before = await refsOf(ctx.tx, page, row)
      const placementId = await rowPlacement(
        ctx.tx,
        page,
        {
          id: row.id,
          itemId: row.item_id as string,
          surfaceId: row.surface_id,
          slotAt: row.slot_at,
        },
        {
          surfaceSource: kind === 'surface' ? 'km' : row.marked_at ? 'km_mark' : 'km',
          refs: { kind: 'post', postRef: theirs.ref },
          occurredAt: theirs.publishedAt,
          origin: 'manual',
          createdBy: ctx.actor.id,
        },
      )
      await addEvidence(ctx.tx, page, {
        placementId,
        source: 'manual',
        kind: 'manual_confirm',
        strength: 'exact',
        externalRef: theirs.ref,
        // «Отменить» takes the post ref back only where this decision wrote it.
        payload: {
          ...base,
          pairs,
          refs_written: before?.id === placementId && before.ref === null,
        },
        eventAt: theirs.publishedAt,
        recordedBy: ctx.actor.id,
        dedupKey: `manual:${randomUUID()}`,
      })
      await bindAssets(
        ctx.tx,
        page,
        placementId,
        pairs.map((pair) => ({
          assetId: pair.asset_id,
          versionId: pair.version_id,
          strength: 'exact' as const,
          mediaRef: pair.media_ref,
        })),
        ctx.actor.id,
      )
    } else {
      // «Стена или фуп?» answered with the other surface: the post is not this row's.
      const placementId = await publicationPlacement(ctx.tx, page, {
        surface: answer,
        surfaceSource: 'km',
        refs: { kind: 'post', postRef: theirs.ref },
        itemId: row.item_id,
        planRowId: null,
        occurredAt: theirs.publishedAt,
        origin: 'manual',
        createdBy: ctx.actor.id,
      })
      await addEvidence(ctx.tx, page, {
        placementId,
        source: 'manual',
        kind: 'manual_confirm',
        strength: 'exact',
        externalRef: theirs.ref,
        payload: { ...base, plan_row_id: null, pairs, surface: answer },
        eventAt: theirs.publishedAt,
        recordedBy: ctx.actor.id,
        dedupKey: `manual:${randomUUID()}`,
      })
      await reject(ctx, page, target, { reason: 'other_surface' })
    }
    await rejectElsewhere(ctx, state, page, theirs.ref, row.id)
  }
  // «Это оно» on one variant answers the others «Не то» in the same decision.
  for (const other of open) if (other.id !== target.id) await reject(ctx, page, other)
}

/** The row's own placement before a decision: its id and whether it already named a post. */
async function refsOf(
  tx: Tx,
  page: Page,
  row: RowRecord,
): Promise<{ id: string; ref: string | null } | null> {
  const { rows } = await tx.execute<{ id: string; ref: string | null }>(sql`
    SELECT id, external_post_ref AS ref FROM placements
     WHERE model_id = ${page.modelId}::uuid AND surface_id = ${row.surface_id}::uuid
       AND manual_key = ${`row:${row.id}`}`)
  return rows[0] ?? null
}

/** «Это оно» on a post with exact files and no proven surface: the person says where it went. */
async function confirmPostSurface(
  ctx: DecisionContext,
  found: PostCaseOpen,
  surface: PostSurface,
): Promise<void> {
  if (!found.itemId) fail('Объект этого поста неизвестен — привяжите его')
  const { post, page } = found
  const placementId = await publicationPlacement(ctx.tx, page, {
    surface,
    surfaceSource: 'km',
    refs: { kind: 'post', postRef: post.ref },
    itemId: found.itemId,
    planRowId: null,
    occurredAt: post.publishedAt,
    origin: 'manual',
    createdBy: ctx.actor.id,
  })
  const mains = await itemMains(ctx.tx, page, found.itemId as string)
  await addEvidence(ctx.tx, page, {
    placementId,
    source: 'manual',
    kind: 'manual_confirm',
    strength: 'exact',
    externalRef: post.ref,
    payload: {
      basis: 'inspected_pair',
      decision_id: ctx.decision,
      post_ref: post.ref,
      post_id: post.id,
      surface,
      pairs: pairsOf(mains, post.mains, projected(post)),
    },
    eventAt: post.publishedAt,
    recordedBy: ctx.actor.id,
    dedupKey: `manual:${randomUUID()}`,
  })
}

async function log(
  ctx: DecisionContext,
  page: Page,
  itemId: string | null,
  phrase: string,
  after: Record<string, unknown>,
) {
  await logAction(ctx.tx, {
    modelId: ctx.model.id,
    action: 'check.decide',
    subjectKind: 'reconcile',
    subjectLabel: phrase,
    itemId,
    after: { страница: page.accountCode, ...after },
  })
}

export async function confirmPair(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseId: string,
  body: { evidence_id: string | null; surface?: PostSurface | undefined },
): Promise<Decided> {
  const found = await openCase(tx, model, caseId)
  const ctx: DecisionContext = { tx, model, actor, decision: randomUUID() }
  if (found.ref.kind === 'row') {
    await confirmRow(ctx, found as RowCase, body.evidence_id, body.surface)
  } else {
    const post = found as PostCaseOpen
    if (post.kind !== 'surface') fail('Пост без плана привязывают к объекту: «Привязать…»')
    if (!body.surface) fail('Выберите: стена или фуп')
    await confirmPostSurface(ctx, post, body.surface as PostSurface)
  }
  const itemId =
    found.ref.kind === 'row' ? (found as RowCase).row.item_id : (found as PostCaseOpen).itemId
  await log(ctx, found.page, itemId, 'Сверка: «Это оно»', {
    основание: 'осмотренная пара',
    ...(actor.type === 'agent' ? { пометка: 'подтверждено агентом' } : {}),
  })
  return { case_id: caseId, verdict: await verdictOf(tx, model, found.ref, found.page) }
}

export async function rejectPair(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseId: string,
  evidenceId: string | null,
): Promise<Decided> {
  const found = await openCase(tx, model, caseId)
  if (found.ref.kind !== 'row') fail('Пост без плана — «Привязать…» или «Не наше»')
  const { row, page, state } = found as RowCase
  const open = openQuestions(state, row.id)
  if (open.length === 0) fail('Здесь нечего отклонять')
  const targets = evidenceId ? open.filter((one) => one.id === evidenceId) : open
  if (targets.length === 0) fail('Такого варианта у случая нет')
  const ctx: DecisionContext = { tx, model, actor, decision: randomUUID() }
  for (const target of targets) await reject(ctx, page, target)
  await log(ctx, page, row.item_id, 'Сверка: «Не то»', { вариантов: targets.length })
  return { case_id: caseId, verdict: await verdictOf(tx, model, found.ref, page) }
}

export async function bindPost(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseId: string,
  publicId: string,
): Promise<Decided> {
  const found = await openCase(tx, model, caseId)
  if (found.ref.kind !== 'post' || (found as PostCaseOpen).kind !== 'unplanned') {
    fail('Пост уже привязан')
  }
  const { post, page } = found as PostCaseOpen
  const item = await findItem(tx, model, publicId)
  const proven = hubSurface(post, page.platform)
  const surface = proven ?? hintSurface(post)
  const placementId = await publicationPlacement(tx, page, {
    surface,
    surfaceSource: proven ? 'hub' : 'hub_hint',
    refs: { kind: 'post', postRef: post.ref },
    itemId: item.id,
    planRowId: null,
    occurredAt: post.publishedAt,
    origin: 'manual',
    createdBy: actor.id,
  })
  const ctx: DecisionContext = { tx, model, actor, decision: randomUUID() }
  await addEvidence(tx, page, {
    placementId,
    source: 'manual',
    kind: 'manual_confirm',
    strength: 'exact',
    externalRef: post.ref,
    payload: {
      basis: 'inspected_pair',
      decision_id: ctx.decision,
      post_ref: post.ref,
      post_id: post.id,
      bind: true,
      pairs: pairsOf(await itemMains(tx, page, item.id), post.mains, projected(post)),
    },
    eventAt: post.publishedAt,
    recordedBy: actor.id,
    dedupKey: `manual:${randomUUID()}`,
  })
  await log(ctx, page, item.id, `Сверка: пост привязан к ${publicId}`, { объект: publicId })
  return { case_id: caseId, verdict: await verdictOf(tx, model, found.ref, page) }
}

export async function outsidePost(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseId: string,
): Promise<Decided> {
  const found = await openCase(tx, model, caseId)
  if (found.ref.kind !== 'post' || (found as PostCaseOpen).kind !== 'unplanned') {
    fail('«Не наше» — только у поста без плана')
  }
  const { post, page } = found as PostCaseOpen
  const proven = hubSurface(post, page.platform)
  const placementId = await publicationPlacement(tx, page, {
    surface: proven ?? hintSurface(post),
    surfaceSource: proven ? 'hub' : 'hub_hint',
    refs: { kind: 'post', postRef: post.ref },
    itemId: null,
    planRowId: null,
    occurredAt: post.publishedAt,
    origin: 'manual',
    outOfCatalog: true,
    createdBy: actor.id,
  })
  await tx.execute(sql`
    UPDATE placements SET out_of_catalog = true, item_id = NULL, item_type = NULL,
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${placementId}::uuid AND NOT out_of_catalog`)
  const ctx: DecisionContext = { tx, model, actor, decision: randomUUID() }
  await addEvidence(tx, page, {
    placementId,
    source: 'manual',
    kind: 'outside_catalog',
    strength: null,
    externalRef: post.ref,
    payload: { decision_id: ctx.decision, post_ref: post.ref, post_id: post.id },
    recordedBy: actor.id,
    dedupKey: `manual:${randomUUID()}`,
  })
  await log(ctx, page, null, 'Сверка: «Не наше»', { пост: post.ref })
  return { case_id: caseId, verdict: await verdictOf(tx, model, found.ref, page) }
}

/** «Отменить»: the last decision on the case is retracted whole; history stays (SPEC §5). */
export async function undoDecision(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseId: string,
): Promise<Decided> {
  const ref = parseCase(caseId)
  let page: Page | null
  let placementIds: string[]
  if (ref.kind === 'row') {
    const row = await rowById(tx, model, ref.id, true)
    page = await pageOf(tx, row.account_id)
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT DISTINCT p.id FROM placements p
        LEFT JOIN placement_evidence e ON e.model_id = p.model_id AND e.placement_id = p.id
       WHERE p.model_id = ${model.id}::uuid
         AND (p.plan_row_id = ${row.id}::uuid OR e.payload ->> 'plan_row_id' = ${row.id})`)
    placementIds = rows.map((one) => one.id)
  } else {
    const { post, page: postPage } = await postOf(tx, model, ref.id)
    page = postPage
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM placements WHERE model_id = ${model.id}::uuid
         AND account_id = ${postPage.accountId}::uuid AND external_post_ref = ${post.ref}`)
    placementIds = rows.map((one) => one.id)
  }
  if (!page) throw new ApiProblem('not_found', 'Такого случая сверки нет')
  await lockPage(tx, page.accountId)
  const { rows: all } = await tx.execute<EvidenceRecord & Record<string, unknown>>(sql`
    SELECT e.id, e.placement_id, e.source, e.kind, e.strength, e.payload,
           e.event_at::text AS event_at, e.recorded_at::text AS recorded_at, e.recorded_by,
           e.corrects_id, NULL AS legacy_fragment, e.external_ref, e.matched_version_id
      FROM placement_evidence e
     WHERE e.model_id = ${model.id}::uuid AND e.placement_id = ANY (${sql.param(placementIds)}::uuid[])
     ORDER BY e.recorded_at, e.id`)
  const live = standingEvidence(all).filter(
    (row) =>
      typeof row.payload.decision_id === 'string' &&
      (row.kind === 'manual_reject' ||
        row.kind === 'outside_catalog' ||
        (row.kind === 'manual_confirm' && row.payload.basis === 'inspected_pair')),
  )
  // Rejects of «taken» posts on other rows go with the confirmation that caused them.
  const last = live.at(-1)
  if (!last) fail('Отменять нечего')
  const decision = (last as EvidenceRecord).payload.decision_id
  const { rows: group } = await tx.execute<{
    id: string
    placement_id: string
    kind: string
    payload: Record<string, unknown>
  }>(sql`
    SELECT e.id, e.placement_id, e.kind, e.payload FROM placement_evidence e
     WHERE e.model_id = ${model.id}::uuid AND e.payload ->> 'decision_id' = ${String(decision)}
       AND NOT EXISTS (SELECT 1 FROM placement_evidence r WHERE r.model_id = e.model_id
                        AND r.corrects_id = e.id AND r.kind = 'retract')`)
  for (const one of group) {
    await addEvidence(tx, page, {
      placementId: one.placement_id,
      source: 'manual',
      kind: 'retract',
      strength: null,
      payload: { decision_id: decision, undo: true },
      recordedBy: actor.id,
      correctsId: one.id,
      dedupKey: `retract:${one.id}`,
    })
    if (one.kind === 'outside_catalog') {
      await tx.execute(sql`
        UPDATE placements SET out_of_catalog = false, row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND id = ${one.placement_id}::uuid`)
    }
    if (one.kind === 'manual_confirm' && one.payload.bind === true) {
      await tx.execute(sql`
        UPDATE placements SET item_id = NULL, item_type = NULL, row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND id = ${one.placement_id}::uuid
           AND NOT EXISTS (SELECT 1 FROM placement_evidence e
                            WHERE e.model_id = placements.model_id AND e.placement_id = placements.id
                              AND e.kind = 'observed' AND e.strength = 'exact')`)
    }
    if (one.kind === 'manual_confirm' && one.payload.refs_written === true) {
      await tx.execute(sql`
        UPDATE placements SET external_post_ref = NULL, occurrence_kind = 'manual',
               occurred_at = NULL, occurred_source = NULL, row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND id = ${one.placement_id}::uuid
           AND NOT EXISTS (SELECT 1 FROM placement_evidence e
                            WHERE e.model_id = placements.model_id AND e.placement_id = placements.id
                              AND e.kind = 'observed' AND e.strength = 'exact')`)
    }
  }
  const ctx: DecisionContext = { tx, model, actor, decision: randomUUID() }
  await log(ctx, page, null, 'Сверка: решение отменено', { решений: group.length })
  return { case_id: caseId, verdict: await verdictOf(tx, model, ref, page) }
}

/**
 * «Подтвердить однозначные» (SPEC §7 «Массовое подтверждение»): only pairs the list marks
 * unambiguous — Fansly, one to one, time and duration within tolerances, equal count; anything
 * else answers `case_resolved` for its id and is left alone.
 */
export async function confirmUnambiguous(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  caseIds: readonly string[],
): Promise<{ id: string; ok: boolean; code: string | null; verdict: PlacementVerdict | null }[]> {
  const state = await loadState(tx, model)
  const cases = await allCases(tx, await checkModel(tx, state))
  const allowed = new Set(cases.filter((one) => one.unambiguous).map((one) => one.id))
  const results = []
  for (const id of caseIds) {
    if (!allowed.has(id)) {
      results.push({ id, ok: false, code: 'case_resolved', verdict: null })
      continue
    }
    const decided = await confirmPair(tx, model, actor, id, { evidence_id: null })
    results.push({ id, ok: true, code: null, verdict: decided.verdict })
  }
  return results
}

export { rowCaseId, surfaceIdOf }
