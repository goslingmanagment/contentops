import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { Model } from '@contentops/contracts/domain/model'
import { PROTOTYPE_NOW } from '../prototype-clock'
import { buildAdminRecords } from './admin-records'
import { buildLoraWorld, idCounters, recordFor } from './lora-world'
import { ARI, COVERAGE, LILY } from './models'
import { buildAgents, buildContractors, buildPeople } from './people'
import { buildIntegrations, buildSystemState, buildThresholds } from './settings'
import {
  buildAriCatalog,
  buildLilyCatalog,
  lilyInbox,
  lilyPlan,
  smallModelNorms,
  smallModelTracks,
} from './small-models'
import { TAG_DICTIONARY } from './vocabulary'
import type { InboxRecord, ModelWorld, PlacementTrack, PlanRowRecord, World } from './world-types'

/** The whole prototype database, built the same way on every call. */

/** A model with a small catalog; with no entries it is a model just added in the settings. */
export function smallModel(
  model: Model,
  entries: CatalogEntry[],
  extra: { rows?: PlanRowRecord[]; tracks?: PlacementTrack[]; inbox?: InboxRecord[] },
): ModelWorld {
  return {
    model,
    items: new Map(entries.map((entry) => [entry.id, recordFor(entry)])),
    tracks: [...smallModelTracks(model, entries), ...(extra.tracks ?? [])],
    plan_rows: new Map((extra.rows ?? []).map((row) => [row.id, row])),
    releases: [],
    norms: new Map(smallModelNorms(model).map((norm) => [norm.account, norm])),
    coverage: new Map(
      model.accounts.map((account) => [
        account.code,
        COVERAGE[account.code] ?? {
          posts_complete: false,
          vault_complete: false,
          visible_from: null,
        },
      ]),
    ),
    inbox: extra.inbox ?? [],
    legacy: {
      progress: {
        processed_folders: 0,
        total_folders: 0,
        old_names: 0,
        unresolved: 0,
        roots: [],
        stalled: null,
      },
      labels: [],
      disputes: [],
    },
    orders: [],
    collections: new Map(),
    promo_unfiled: new Map(),
    handoffs: [],
    channels: [],
    journal: [],
    recent: new Map(),
    counters: idCounters(entries),
    disk_checked_at: '2026-09-22T11:16:00Z',
    catalog_version: 1,
    summary_version: 1,
  }
}

function countTags(world: World) {
  const uses = new Map<string, number>()
  for (const model of world.models.values()) {
    for (const record of model.items.values()) {
      for (const tag of record.entry.tags) uses.set(tag, (uses.get(tag) ?? 0) + 1)
    }
  }
  world.tags = TAG_DICTIONARY.map((tag) => ({ ...tag, uses: uses.get(tag.key) ?? 0, version: 1 }))
}

export function createWorld(): World {
  const world: World = {
    models: new Map(),
    people: buildPeople(PROTOTYPE_NOW),
    agents: buildAgents(),
    contractors: buildContractors(),
    integrations: buildIntegrations(),
    thresholds: buildThresholds(),
    tags: [],
    system: buildSystemState(),
    admin: buildAdminRecords(),
  }
  world.models.set('lora', buildLoraWorld(world))
  const lilyCatalog = buildLilyCatalog()
  const lily = lilyPlan(lilyCatalog)
  world.models.set('lily', smallModel(LILY, lilyCatalog, { ...lily, inbox: lilyInbox() }))
  world.models.set('ari', smallModel(ARI, buildAriCatalog(), {}))
  countTags(world)
  return world
}
