import { addMinutes } from '../../../clock'
import type { PostSurface } from '../../../commands/check'
import type { Instant } from '../../../domain/common'
import type { Evidence } from '../../../domain/placement'
import { evaluateTrack, type FactsContext } from '../../../fixtures/facts'
import { nameOf, PERSON } from '../../../fixtures/people'
import type { PlacementTrack } from '../../../fixtures/world-types'
import { pastVerb } from '../../../format'
import { checkRoutes } from '../../routes/check'
import { rule } from '../domain-error'
import { type BoundRoute, bind } from '../handler'
import type { MockState } from '../state'
import { checkCase, checkList, notOursCases, resolvedCases, trackOf } from '../views/check'
import { unverifiedRows } from '../views/check-unverified'
import { recordOf } from '../views/item'
import { wholeList } from '../views/paginate'
import { actorSays } from './actor-says'
import { placementsChanged } from './model-records'

/** «Сверить» decisions (DESIGN §4.15): «Это оно», «Не то», «Привязать…», «Не наше». */

/** Hub allows 60 album checks a day (DESIGN §2.5). */
const UPLOAD_CHECKS_PER_DAY = 60

/**
 * `?demo=conflict` (DESIGN §3.10, §3.3): пока человек смотрел на пару, её решил другой. Его
 * ответ записан минутой раньше — пара подтверждена, пост без плана отмечен «Не наше».
 */
function decidedMeanwhile(state: MockState, context: FactsContext, track: PlacementTrack) {
  const other = state.principal.id === PERSON.nikita ? PERSON.diana : PERSON.nikita
  const by = nameOf(other, state.world.people)
  const base = {
    id: `e-${track.id}-${track.evidence.length + 1}`,
    recorded_at: addMinutes(state.clock.now(), -1),
    by,
  }
  track.evidence.push(
    track.item_id
      ? { ...base, kind: 'manual_confirm', basis: 'pair' }
      : { ...base, kind: 'outside_catalog' },
  )
  placementsChanged(context.model)
  return by
}

function openCase(state: MockState, context: FactsContext, caseId: string): PlacementTrack {
  const track = trackOf(context, caseId)
  if (evaluateTrack(context, track).sign !== 'turn') throw rule('case_resolved', 'Случай уже решён')
  if (state.demo === 'conflict') {
    const by = decidedMeanwhile(state, context, track)
    throw rule('case_resolved', `Случай уже ${pastVerb('решил', by.gender)} ${by.name}`)
  }
  return track
}

function evidenceBy(
  state: MockState,
  kind: 'manual_confirm' | 'manual_reject' | 'outside_catalog',
  track: PlacementTrack,
  extra: { rejects?: string | null; at?: Instant } = {},
): Evidence {
  const base = {
    id: `e-${track.id}-${track.evidence.length + 1}`,
    recorded_at: extra.at ?? state.clock.now(),
    by: nameOf(state.principal.id, state.world.people),
  }
  if (kind === 'manual_confirm') return { ...base, kind, basis: 'pair' }
  if (kind === 'manual_reject') return { ...base, kind, rejects: extra.rejects ?? null }
  return { ...base, kind }
}

function resolution(context: FactsContext, track: PlacementTrack) {
  placementsChanged(context.model)
  return { case_id: track.id, verdict: evaluateTrack(context, track) }
}

/** «Стена или фуп?» is answered with «Это оно»; a case that knows its surface takes no answer. */
function answerSurface(context: FactsContext, track: PlacementTrack, surface?: PostSurface) {
  const asked = evaluateTrack(context, track).level === 'surface_unknown'
  if (asked && !surface) throw rule('invalid_request', 'Выберите: стена или фуп')
  if (!asked && surface) throw rule('invalid_request', 'Куда вышел пост, уже известно')
  if (surface) track.surface = surface
}

/** Undoing «Привязать…» unbinds the post: it is again a post without plan. */
function unbindIfBound(track: PlacementTrack, undone: Evidence) {
  const unplanned = track.evidence.some((evidence) => evidence.kind === 'hub_unplanned')
  if (undone.kind === 'manual_confirm' && unplanned) track.item_id = null
}

/** «Это оно» on one pair; the other variants of the same case are answered «Не то». */
function confirmPair(state: MockState, track: PlacementTrack, evidenceId: string | null) {
  const candidates = track.evidence.filter((evidence) => evidence.kind === 'hub_candidate')
  if (candidates.length > 1 && !evidenceId) throw rule('invalid_request', 'Выберите вариант')
  // One decision, one moment: «Отменить» takes back the answers to the other variants too.
  const at = state.clock.now()
  for (const other of candidates) {
    if (evidenceId && other.id !== evidenceId)
      track.evidence.push(evidenceBy(state, 'manual_reject', track, { rejects: other.id, at }))
  }
  track.evidence.push(evidenceBy(state, 'manual_confirm', track, { at }))
}

export function checkHandlers(): BoundRoute[] {
  return [
    bind(checkRoutes.list, 'read', ({ facts }) => checkList(facts())),
    bind(checkRoutes.resolved, 'read', ({ facts }) => wholeList(resolvedCases(facts()))),
    bind(checkRoutes.notOurs, 'read', ({ facts }) => wholeList(notOursCases(facts()))),
    bind(checkRoutes.unverified, 'read', ({ facts }) => wholeList(unverifiedRows(facts()))),
    bind(checkRoutes.get, 'read', ({ facts, params }) => {
      const context = facts()
      const found = checkCase(context, trackOf(context, params.case))
      if (!found) throw rule('case_resolved', 'Случай уже решён')
      return found
    }),
    bind(checkRoutes.confirmPair, 'staff', (context) => {
      const facts = context.facts()
      const track = openCase(context.state, facts, context.params.case)
      answerSurface(facts, track, context.body.surface)
      confirmPair(context.state, track, context.body.evidence_id)
      context.log({
        area: 'check',
        action: 'placement.confirm',
        phrase: `${actorSays(context.state, 'подтвердил')} ${track.item_id ?? 'пост'}: осмотренная пара`,
        item_id: track.item_id,
      })
      return resolution(facts, track)
    }),
    bind(checkRoutes.reject, 'staff', (context) => {
      const facts = context.facts()
      const track = openCase(context.state, facts, context.params.case)
      track.evidence.push(
        evidenceBy(context.state, 'manual_reject', track, { rejects: context.body.evidence_id }),
      )
      context.log({
        area: 'check',
        action: 'placement.reject',
        phrase: `${actorSays(context.state, 'ответил')} «Не то» по ${track.item_id ?? 'посту'}`,
        item_id: track.item_id,
      })
      return resolution(facts, track)
    }),
    bind(checkRoutes.bind, 'staff', (context) => {
      const facts = context.facts()
      const track = openCase(context.state, facts, context.params.case)
      if (track.item_id) throw rule('invalid_request', 'Пост уже привязан')
      const record = recordOf(facts, context.body.item_id)
      track.item_id = record.entry.id
      track.evidence.push(evidenceBy(context.state, 'manual_confirm', track))
      context.log({
        area: 'check',
        action: 'placement.bind',
        phrase: `${actorSays(context.state, 'привязал')} пост к ${record.entry.id}`,
        item_id: record.entry.id,
      })
      return resolution(facts, track)
    }),
    bind(checkRoutes.outside, 'staff', (context) => {
      const facts = context.facts()
      const track = openCase(context.state, facts, context.params.case)
      track.evidence.push(evidenceBy(context.state, 'outside_catalog', track))
      context.log({
        area: 'check',
        action: 'placement.outside',
        phrase: `${actorSays(context.state, 'отметил')} пост как «Не наше»`,
      })
      return resolution(facts, track)
    }),
    bind(checkRoutes.undo, 'staff', (context) => {
      const facts = context.facts()
      const track = trackOf(facts, context.params.case)
      const decisions = new Set<Evidence['kind']>([
        'manual_confirm',
        'manual_reject',
        'outside_catalog',
      ])
      const last = [...track.evidence].reverse().find((evidence) => decisions.has(evidence.kind))
      if (!last) throw rule('invalid_request', 'Отменять нечего')
      const itemId = track.item_id
      track.evidence = track.evidence.filter(
        (evidence) => !decisions.has(evidence.kind) || evidence.recorded_at !== last.recorded_at,
      )
      unbindIfBound(track, last)
      context.log({
        area: 'check',
        action: 'placement.undo',
        phrase: `${actorSays(context.state, 'отменил')} решение по ${itemId ?? 'посту'}`,
        item_id: itemId,
      })
      return resolution(facts, track)
    }),
    bind(checkRoutes.checkUpload, 'staff', (context) => {
      trackOf(context.facts(), context.params.case)
      if (context.state.upload_checks_today >= UPLOAD_CHECKS_PER_DAY) {
        return { state: 'limit', text: 'Лимит Hub на сегодня — проверим завтра' }
      }
      context.state.upload_checks_today += 1
      return { state: 'queued', text: 'В очереди · проверим за сутки' }
    }),
    bind(checkRoutes.confirmUnambiguous, 'staff', (context) => {
      const facts = context.facts()
      const allowed = new Set(checkList(facts).unambiguous_ids)
      const results = context.body.case_ids.map((id, index) => {
        if (!allowed.has(id)) return { id, ok: false, code: 'case_resolved', verdict: null }
        const track = trackOf(facts, id)
        if (context.state.demo === 'conflict' && index === 0) {
          decidedMeanwhile(context.state, facts, track)
          return { id, ok: false, code: 'case_resolved', verdict: null }
        }
        confirmPair(context.state, track, null)
        return { id, ok: true, code: null, verdict: evaluateTrack(facts, track) }
      })
      placementsChanged(facts.model)
      const done = results.filter((result) => result.ok).length
      context.log({
        area: 'check',
        action: 'placement.confirm',
        phrase: `${actorSays(context.state, 'подтвердил')} однозначные пары: ${done}`,
      })
      return { results }
    }),
  ]
}
