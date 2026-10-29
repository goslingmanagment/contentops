import type { DownloadCommand, MakePpvCommand, MontageFile } from '../../../commands/objects'
import type { CatalogEntry } from '../../../domain/catalog'
import { ITEM_TYPE_INFO, itemTypeOf } from '../../../domain/item-type'
import { MARKUP_FIELD_LABEL, summarizeMarkup } from '../../../domain/markup'
import type { SurfaceKind } from '../../../domain/placement'
import type { ProvenanceLink } from '../../../domain/provenance'
import { synthesizeFiles, ydiskPathFor } from '../../../fixtures/item-files'
import type { ItemRecord, ModelWorld } from '../../../fixtures/world-types'
import { versionTag } from '../../headers'
import { objectRoutes } from '../../routes/objects'
import { notFound, rule } from '../domain-error'
import { type BoundRoute, bind, todayOf } from '../handler'
import type { MockState } from '../state'
import {
  activeEntries,
  catalogIndex,
  pageSummaryIndex,
  pairKey,
  summariesByPair,
} from '../views/catalog'
import { itemDetail, markupOf, recordOf } from '../views/item'
import { notUploadedPage } from '../views/not-uploaded'
import { paginate, wholeList } from '../views/paginate'
import { planRowView } from '../views/plan'
import { resolveQuery, searchModel } from '../views/search'
import { actorSays } from './actor-says'
import { startDownload } from './download-delivery'
import {
  catalogChanged,
  newEntry,
  newRecord,
  nextItemId,
  placementsChanged,
  touch,
} from './model-records'
import { buildRow, insertRow, rowProblem } from './plan-records'

/** Catalog of a model: index resources, the object page and its commands (DESIGN §4.1–4.5). */

function surfaceForUpload(entry: CatalogEntry): SurfaceKind {
  if (entry.type === 'set') return 'wall'
  if (entry.type === 'fyp') return 'fyp'
  return 'vault'
}

function matchesWhere(
  summaries: ReturnType<typeof summariesByPair>,
  entry: CatalogEntry,
  where: readonly string[],
): boolean {
  return where.every((condition) => {
    const [account, answer] = condition.split(':')
    const placed = (summaries.get(pairKey(entry.id, account ?? ''))?.placed_on.length ?? 0) > 0
    return answer === 'yes' ? placed : !placed
  })
}

function linkBack(model: ModelWorld, record: ItemRecord, link: ProvenanceLink) {
  const other = model.items.get(link.item_id)
  if (!other) return
  other.provenance.push({
    ...link,
    id: `${link.id}-back`,
    direction: link.direction === 'out' ? 'in' : 'out',
    item_id: record.entry.id,
    item_type: record.entry.type,
    item_title: record.entry.title,
  })
  touch(other)
}

interface NewPpv {
  kind: MakePpvCommand['kind']
  title: string
  /** An own montage becomes the master; without it the master of the custom is taken as is. */
  montage: MontageFile | null
}

/**
 * Accepting a PPV from a custom: the number is issued here, the link «PPV из кастома» is
 * written both ways, the fan's name is not carried over (DESIGN §4.2).
 */
function acceptPpv(state: MockState, model: ModelWorld, custom: ItemRecord, ppv: NewPpv) {
  const id = nextItemId(model, 'ppv')
  const entry = newEntry(id, 'ppv', ppv.title, todayOf(state))
  entry.ppv_kind = ppv.kind
  entry.duration_s = custom.entry.duration_s
  entry.tags = [...custom.entry.tags]
  const record = newRecord(entry, ydiskPathFor(entry))
  const montage = ppv.montage
  if (montage) {
    record.files = synthesizeFiles(entry).map((file) =>
      file.role === 'master'
        ? { ...file, file_name: montage.file_name, size_bytes: montage.size_bytes }
        : file,
    )
  }
  const link: ProvenanceLink = {
    id: `pv-${id}-cus`,
    relation: 'ppv_from_custom',
    direction: 'out',
    item_id: custom.entry.id,
    item_type: 'custom',
    item_title: custom.entry.title,
    extra: null,
    confirmed: true,
  }
  record.provenance.push(link)
  model.items.set(id, record)
  linkBack(model, record, link)
  custom.entry.ppv_made_as = id
  touch(custom)
  catalogChanged(model)
  return id
}

export function objectHandlers(): BoundRoute[] {
  return [
    bind(objectRoutes.catalogIndex, 'read', ({ facts }) => catalogIndex(facts()), {
      etag: (body) => body.etag,
    }),
    bind(objectRoutes.pageSummaries, 'read', ({ facts }) => pageSummaryIndex(facts()), {
      etag: (body) => body.etag,
    }),
    bind(objectRoutes.list, 'read', ({ facts, query }) => {
      const context = facts()
      const summaries = summariesByPair(context)
      const entries = activeEntries(context.model)
        .filter((entry) => !query.type || entry.type === query.type)
        .filter((entry) => !query.kind || entry.ppv_kind === query.kind)
        .filter((entry) => !query.tag || query.tag.every((tag) => entry.tags.includes(tag)))
        .filter((entry) => !query.where || matchesWhere(summaries, entry, query.where))
        .sort((left, right) => right.id.localeCompare(left.id))
      return paginate(entries, (entry) => entry.id, query.cursor, query.limit)
    }),
    bind(objectRoutes.recent, 'read', ({ model, state }) =>
      wholeList(model().recent.get(state.principal.id) ?? []),
    ),
    bind(objectRoutes.deleted, 'read', ({ model }) =>
      wholeList(
        [...model().items.values()].flatMap((record) => {
          const lifecycle = record.lifecycle
          if (lifecycle.state === 'active') return []
          return [
            {
              item_id: record.entry.id,
              title: record.entry.title,
              deleted_at: lifecycle.at,
              deleted_by: lifecycle.state === 'deleted' ? lifecycle.by : 'слияние',
              merged_into: lifecycle.state === 'merged' ? lifecycle.into : null,
            },
          ]
        }),
      ),
    ),
    bind(objectRoutes.resolve, 'read', ({ model, query }) => resolveQuery(model(), query.q)),
    bind(objectRoutes.search, 'read', ({ model, state, query }) =>
      searchModel(state.world, model(), query.q),
    ),
    bind(objectRoutes.notUploaded, 'read', ({ facts, query }) =>
      notUploadedPage(facts(), query.account),
    ),
    bind(objectRoutes.alreadyUploaded, 'staff', (context) => {
      const { body, state } = context
      const model = context.model()
      const today = todayOf(state)
      const results = body.items.map((itemId) => {
        const record = model.items.get(itemId)
        if (!record) return { id: itemId, ok: false, code: 'not_found' }
        const input = {
          item_id: itemId,
          account: body.account,
          surface: surfaceForUpload(record.entry),
          date: today,
          time: null,
          fyp_version: null,
          assignee: null,
          note: null,
          requires_new_upload: false,
          awaiting_montage: null,
          marked: 'posted' as const,
        }
        const problem = rowProblem(model, input)
        if (problem) return { id: itemId, ok: false, code: problem.code }
        insertRow(model, buildRow(state, model, input))
        return { id: itemId, ok: true, code: null }
      })
      context.log({
        area: 'plan',
        action: 'plan.already_uploaded',
        phrase: `${actorSays(context.state, 'отметил')} залитым ${results.filter((result) => result.ok).length} объектов`,
      })
      return { results }
    }),
    bind(
      objectRoutes.get,
      'read',
      ({ facts, params, state }) => itemDetail(facts(), params.id, state.principal.role),
      {
        etag: (body) => versionTag(body.version),
      },
    ),
    bind(objectRoutes.updateField, 'staff', (context) => {
      const { params, body } = context
      const facts = context.facts()
      const record = recordOf(facts, params.id)
      if (body.key !== params.field)
        throw rule('invalid_request', 'Поле в пути и в теле не совпадают')
      const markup = markupOf(record)
      const field = markup.find((candidate) => candidate.field.key === body.key)
      if (!field) throw notFound('Такого поля нет')
      context.requireVersion(field.version, body.key)
      field.field = body
      field.version += 1
      field.status = 'confirmed'
      field.confirmed_by = context.state.principal.name
      field.confirmed_at = context.state.clock.now()
      field.source_hint = null
      if (body.key === 'title') record.entry.title = body.value
      if (body.key === 'tags') record.entry.tags = body.value
      if (body.key === 'description') record.description = body.value
      record.entry.markup = summarizeMarkup(markup)
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'markup.update',
        phrase: `${actorSays(context.state, 'изменил')} «${MARKUP_FIELD_LABEL[body.key]}» у ${params.id}`,
        item_id: params.id,
      })
      return itemDetail(facts, params.id, context.state.principal.role)
    }),
    bind(objectRoutes.confirmMarkup, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const markup = markupOf(record)
      for (const seen of context.body.fields) {
        const field = markup.find((candidate) => candidate.field.key === seen.key)
        if (!field || field.version !== seen.version || field.status === 'empty') continue
        field.status = 'confirmed'
        field.confirmed_by = context.state.principal.name
        field.confirmed_at = context.state.clock.now()
      }
      record.entry.markup = summarizeMarkup(markup)
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'markup.confirm',
        phrase: `${actorSays(context.state, 'подтвердил')} разметку ${context.params.id}`,
        item_id: context.params.id,
      })
      return itemDetail(facts, context.params.id, context.state.principal.role)
    }),
    bind(objectRoutes.saveFrameCheck, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      const detail = itemDetail(facts, record.entry.id, context.state.principal.role)
      const master = detail.files.find((file) => file.role === 'master')
      const { body } = context
      if (!master?.versions.some((version) => version.no === body.version) && body.version !== 1) {
        throw rule('invalid_request', `У ${record.entry.id} нет мастера v${body.version}`)
      }
      const keys = new Set([
        ...detail.frames.map((frame) => `t:${frame.t_s}`),
        ...detail.files.map((file) => file.key),
      ])
      const unknown = body.blocked.find((key) => !keys.has(key))
      if (unknown !== undefined) {
        throw rule('invalid_request', `Кадра ${unknown} у ${record.entry.id} нет`)
      }
      record.frame_check = {
        version: body.version,
        blocked: [...new Set(body.blocked)],
        verdict: body.verdict,
        by: context.state.principal.name,
        at: context.state.clock.now(),
      }
      touch(record)
      context.log({
        area: 'catalog',
        action: 'item.frame_check',
        phrase: `${actorSays(context.state, 'проверил')} кадры ${record.entry.id} для v${body.version}: ${body.verdict === 'send' ? 'можно отправлять' : 'не отправлять'}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectRoutes.setFlags, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      const { body } = context
      if (body.second_person === true && !record.entry.second_person) {
        const onlyFans = new Set(
          facts.model.model.accounts
            .filter((account) => account.platform === 'onlyfans')
            .map((account) => account.code),
        )
        const rows = [...facts.model.plan_rows.values()].filter(
          (row) =>
            row.item_id === record.entry.id &&
            onlyFans.has(row.account) &&
            !row.cancelled &&
            !row.mark,
        )
        if (rows.length > 0 && !body.cancel_onlyfans_rows) {
          throw rule('second_person_onlyfans', `Снимет ${rows.length} строки на OnlyFans`, {
            rows: rows.length,
          })
        }
        for (const row of rows)
          row.cancelled = {
            at: context.state.clock.now(),
            by: context.state.principal.id,
            reason: null,
          }
      }
      if (body.second_person !== undefined) record.entry.second_person = body.second_person
      if (body.fan_name !== undefined) record.entry.fan_name = body.fan_name
      touch(record)
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'item.flags',
        phrase: `${actorSays(context.state, 'изменил')} отметки ${record.entry.id}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectRoutes.download, 'staff', (context) => {
      const model = context.model()
      const record = recordOf(context.facts(), context.params.id)
      const row = context.body.plan_row ? model.plan_rows.get(context.body.plan_row) : undefined
      if (context.body.plan_row && row?.item_id !== record.entry.id) {
        throw notFound('Такой строки плана у объекта нет')
      }
      const answer = startDownload(context.state, model, record, context.body, row)
      if (row) {
        row.downloaded = {
          at: context.state.clock.now(),
          by: context.state.principal.id,
          meta_stripped: context.body.strip_metadata,
        }
      }
      context.log({
        area: 'catalog',
        action: 'item.download',
        phrase: `${actorSays(context.state, 'скачал')} ${record.entry.id}`,
        item_id: record.entry.id,
      })
      return answer
    }),
    bind(objectRoutes.addLink, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const other = recordOf(facts, context.body.item_id)
      const link: ProvenanceLink = {
        id: `pv-${record.entry.id}-${record.provenance.length + 1}`,
        relation: context.body.relation,
        direction: context.body.direction,
        item_id: other.entry.id,
        item_type: itemTypeOf(other.entry.id),
        item_title: other.entry.title,
        extra: null,
        confirmed: true,
      }
      record.provenance.push(link)
      linkBack(facts.model, record, link)
      touch(record)
      context.log({
        area: 'catalog',
        action: 'provenance.add',
        phrase: `${actorSays(context.state, 'добавил')} связь ${record.entry.id} — ${other.entry.id}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectRoutes.confirmLink, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const link = record.provenance.find((candidate) => candidate.id === context.params.link)
      if (!link) throw notFound('Такой связи нет')
      link.confirmed = true
      touch(record)
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectRoutes.removeLink, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const link = record.provenance.find((candidate) => candidate.id === context.params.link)
      if (!link) throw notFound('Такой связи нет')
      record.provenance = record.provenance.filter((candidate) => candidate.id !== link.id)
      const other = facts.model.items.get(link.item_id)
      if (other)
        other.provenance = other.provenance.filter(
          (candidate) =>
            candidate.item_id !== record.entry.id || candidate.relation !== link.relation,
        )
      touch(record)
      context.log({
        area: 'catalog',
        action: 'provenance.remove',
        phrase: `${actorSays(context.state, 'убрал')} связь ${record.entry.id} — ${link.item_id}`,
        item_id: record.entry.id,
      })
      return itemDetail(facts, record.entry.id, context.state.principal.role)
    }),
    bind(objectRoutes.uploadNow, 'staff', (context) => {
      const { state, body } = context
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      const now = state.clock.now()
      const input = {
        item_id: record.entry.id,
        account: body.account,
        surface: body.surface,
        date: todayOf(state),
        // «На сегодня» без часа: строка не становится «пропущено» в ту же минуту.
        time: null,
        fyp_version: null,
        assignee: state.principal.id,
        note: null,
        requires_new_upload: false,
        awaiting_montage: null,
        marked: null,
      }
      const problem = rowProblem(facts.model, input)
      if (problem) throw rule('second_person_onlyfans', problem.text)
      const row = insertRow(facts.model, buildRow(state, facts.model, input))
      const command: DownloadCommand = {
        kind: 'platform',
        strip_metadata: true,
        account: body.account,
      }
      const download = startDownload(state, facts.model, record, command, row)
      row.downloaded = { at: now, by: state.principal.id, meta_stripped: true }
      context.log({
        area: 'plan',
        action: 'plan.upload_now',
        phrase: `${actorSays(context.state, 'поставил')} ${record.entry.id} на сегодня · залить сейчас`,
        item_id: record.entry.id,
      })
      return { row: planRowView(facts, row), download }
    }),
    bind(objectRoutes.makePpv, 'staff', (context) => {
      const { state, body } = context
      const facts = context.facts()
      const custom = recordOf(facts, context.params.id)
      if (custom.entry.type !== 'custom') throw rule('invalid_request', 'PPV делается из кастома')
      if (custom.entry.ppv_made_as)
        throw rule('invalid_request', `PPV уже сделан: ${custom.entry.ppv_made_as}`)
      if (custom.ppv_montage !== undefined)
        throw rule('accept_blocked', 'Монтаж для этого PPV уже загружается')
      // Мастер как есть — только когда имени фана в ролике точно нет (DESIGN §6.6).
      if (body.source === 'as_is' && custom.entry.fan_name !== 'no')
        throw rule('invalid_request', 'В ролике может звучать имя фана — нужен свой монтаж')
      const montage = body.montage
      if (body.source === 'upload' && !montage) throw rule('invalid_request', 'Нет файла монтажа')
      const ppv = { kind: body.kind, title: body.title, montage }
      if (!montage) {
        const id = acceptPpv(state, facts.model, custom, ppv)
        context.log({
          area: 'catalog',
          action: 'item.make_ppv',
          phrase: `${actorSays(context.state, 'сделал')} ${id} из ${custom.entry.id}`,
          item_id: id,
        })
        return { item_id: id, how: 'new', next_step: 'Добавить тизер' }
      }
      // Загрузка с целью «PPV из CUS-…» принимается сама, когда проверка прошла (§3.7):
      // до этого номера нет — принять можно только проверенный мастер (SPEC §4).
      const operation = state.operations.start({
        model: facts.model.model.code,
        kind: 'montage_upload',
        label: `Монтаж → PPV из ${custom.entry.id}`,
        done_label: `Монтаж принят → PPV из ${custom.entry.id}`,
        result: null,
        on_done: () => {
          delete custom.ppv_montage
          const id = acceptPpv(state, facts.model, custom, ppv)
          context.log({
            area: 'catalog',
            action: 'item.make_ppv',
            phrase: `${actorSays(context.state, 'сделал')} ${id} из ${custom.entry.id} · принято при загрузке`,
            item_id: id,
          })
          return { download_url: null, file_name: null, size_bytes: null, item_id: id }
        },
      })
      custom.ppv_montage = operation.id
      touch(custom)
      context.log({
        area: 'catalog',
        action: 'item.upload_montage',
        phrase: `${actorSays(context.state, 'загрузил')} монтаж для PPV из ${custom.entry.id}`,
        item_id: custom.entry.id,
      })
      return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
    }),
    bind(objectRoutes.changeType, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      const id = nextItemId(facts.model, context.body.type)
      const entry = {
        ...record.entry,
        id,
        type: context.body.type,
        cover: { ...record.entry.cover, key: id },
      }
      facts.model.items.set(id, {
        ...record,
        entry,
        version: 1,
        provenance: [...record.provenance],
      })
      record.lifecycle = { state: 'merged', into: id, at: context.state.clock.now() }
      catalogChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'item.change_type',
        phrase: `${actorSays(context.state, 'сменил')} тип ${record.entry.id} → ${id} (${ITEM_TYPE_INFO[context.body.type].noun})`,
        item_id: id,
      })
      return { item_id: id }
    }),
    bind(objectRoutes.remove, 'staff', (context) => {
      const facts = context.facts()
      const record = recordOf(facts, context.params.id)
      context.requireVersion(record.version)
      const now = context.state.clock.now()
      record.lifecycle = { state: 'deleted', at: now, by: context.state.principal.name }
      for (const row of facts.model.plan_rows.values()) {
        if (row.item_id === record.entry.id && !row.mark && !row.cancelled) {
          row.cancelled = { at: now, by: context.state.principal.id, reason: null }
        }
      }
      catalogChanged(facts.model)
      placementsChanged(facts.model)
      context.log({
        area: 'catalog',
        action: 'item.delete',
        phrase: `${actorSays(context.state, 'удалил')} ${record.entry.id}`,
        item_id: record.entry.id,
      })
      return { ok: true }
    }),
  ]
}
