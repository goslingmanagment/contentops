import { findIdMentions } from './ids.ts'
import { parseLegacyName } from './name.ts'
import { parseLegacyPath } from './path.ts'
import type { RegistryClaim } from './registry.ts'
import { looseKey, PARSER_VERSION, relativePath } from './text.ts'
import {
  type ClaimOf,
  ITEM_TYPE_CODES,
  type ItemTypeCode,
  type LegacyDate,
  type ParsedLegacyPath,
  type ProposedAccount,
} from './types.ts'

/**
 * Dry run of the import (PLAN этап 3 «Сухой прогон (`import plan`)», SPEC §6.3–6.4): what the
 * metadata pass of the frozen snapshot would write — number claims with their §6.4 decision,
 * the counter reserve, labels for the КМ, unparsed names, SXT-010/011 evidence, «Старый
 * формат», SMM folders to mark. Nothing here writes: the stage-3 import feeds it from the
 * snapshot rows and persists the result.
 */

/** One row of a snapshot listing (SPEC §6.3 «Замороженный снимок»). */
export interface LegacyListingEntry {
  /** Root-relative path (`disk:/` is accepted); an archive member is `<archive>/<inner path>`. */
  path: string
  isDir: boolean
  size?: number | null
  md5?: string | null
  sha256?: string | null
  /** Upload time (`cr` of the snapshot), ISO. */
  createdAt?: string | null
  modifiedAt?: string | null
  /** EXIF time of the shot. */
  shotAt?: string | null
  resourceId?: string | null
  mediaType?: string | null
  /** Member of an archive's table of contents (schema §9.7 `archive_entry_no`). */
  archiveEntry?: { archivePath: string; entryNo: number } | null
  /** The folder or archive could not be listed completely: an incomplete input (SPEC §6.3). */
  incomplete?: boolean
}

export interface VaultAlbumEvidence {
  title: string
  /** `hub:fansly:<album id>` or similar: where the agent read it. */
  source: string
}

export interface LegacyImportOptions {
  registry?: readonly RegistryClaim[]
  /** `id_counters.next_number` now; the reserve only goes up (`GREATEST`, schema §9.7). */
  currentCounters?: Partial<Record<ItemTypeCode, number>>
  /** Vault album titles the agent read from Hub — evidence for SXT-010/011 (SPEC §6.4). */
  vaultAlbums?: readonly VaultAlbumEvidence[]
  foreignModelNames?: readonly string[]
  /** Examples per label for the КМ (default 5). */
  exampleLimit?: number
}

export type NumberDecision = 'keep' | 'renumber' | 'typo' | 'unclear'

export type NumberClaimSource =
  | { kind: 'path'; path: string; resourceId: string | null }
  | { kind: 'registry'; row: number; folder: string; claimKey: string }
  | { kind: 'evidence'; text: string; source: string }

/** A future `legacy_number_claims` row (schema §3.4). */
export interface NumberClaimPlan {
  type: ItemTypeCode
  claimedNumber: number
  source: NumberClaimSource
  /** Registry row that names the same folder. */
  registryRow: number | null
  decision: NumberDecision
  /** `keep` — the claimed number; `typo` — the registry's; otherwise `null`. */
  assignedNumber: number | null
  /** `renumber`: the number the live counter would give in this order; final at acceptance. */
  projectedNumber: number | null
  releaseDate: string | null
  reason: string
}

export interface CollisionUnitPlan {
  name: string
  paths: string[]
  registryRow: number | null
  releaseDate: string | null
  decision: NumberDecision
  assignedNumber: number | null
  projectedNumber: number | null
}

export interface CollisionPlan {
  type: ItemTypeCode
  number: number
  resolution: 'earliest_keeps' | 'unclear'
  reason: string
  units: CollisionUnitPlan[]
}

export interface TypoPlan {
  type: ItemTypeCode
  name: string
  paths: string[]
  claimedNumber: number
  registryNumber: number
  registryRow: number
}

export interface CounterReservePlan {
  type: ItemTypeCode
  maxClaimed: number | null
  current: number | null
  /** `GREATEST(current, max + 1)`; 1 is only the starting floor. */
  next: number
  /** Numbers below the max no source claims: never filled by the counter. */
  holes: number[]
}

export interface SextingEvidencePlan {
  number: number
  status: 'reserve' | 'hole'
  evidence: { source: string; text: string }[]
}

export interface LabelPlan {
  label: string
  kind: 'used' | 'posted'
  proposedAccount: ProposedAccount
  count: number
  withDate: number
  withoutDate: number
  examples: string[]
}

export interface UnparsedPlan {
  path: string
  isDir: boolean
  fragments: string[]
}

export interface OldFormatPlan {
  folder: string
  files: number
  dirs: number
  bytes: number
  numberAliases: { type: ItemTypeCode; number: number; path: string }[]
  labels: number
  unknownFragments: number
}

export interface SmmFolderPlan {
  path: string
  channel: string | null
  files: number
  bytes: number
  firstUpload: string | null
  lastUpload: string | null
  /** SPEC §6.3: the dry run lists, a person or the agent marks; transfers only for packs. */
  mark: 'пак подрядчику или съёмка вендора — отметить'
}

export interface ArchivePlan {
  path: string
  bytes: number | null
  foreignModel: string | null
  entriesListed: number
  incomplete: boolean
}

/** Exact copies by the hash of the listing: one blob, several location aliases (legacy §8). */
export interface DuplicatePlan {
  hash: string
  hashKind: 'sha256' | 'md5'
  size: number | null
  paths: string[]
}

export interface CoveragePlan {
  entries: number
  files: number
  dirs: number
  /** Entries with at least one claim other than `unknown`. */
  withClaim: number
  /** Entries without `unknown` claims (structural names and camera files included). */
  withoutUnknown: number
  unknownFragments: number
  unknownByRoot: Record<string, number>
}

export interface LegacyImportPlan {
  parserVersion: string
  entries: ParsedLegacyPath[]
  numberClaims: NumberClaimPlan[]
  collisions: CollisionPlan[]
  typos: TypoPlan[]
  reserve: CounterReservePlan[]
  sextings: SextingEvidencePlan[]
  labels: LabelPlan[]
  unparsed: UnparsedPlan[]
  oldFormat: OldFormatPlan[]
  smmFolders: SmmFolderPlan[]
  archives: ArchivePlan[]
  duplicates: DuplicatePlan[]
  incompleteInputs: string[]
  coverage: CoveragePlan
}

/** SXT numbers that are reserved only by a source naming them (SPEC §6.4). */
export const SXT_EVIDENCE_NUMBERS = [10, 11] as const

const ROOT_FILES = '(корень)'

/** Code-unit order: the same on every machine, unlike `localeCompare`. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ── Listing ─────────────────────────────────────────────────────────────────────────────

interface Row {
  entry: LegacyListingEntry
  parsed: ParsedLegacyPath
  implicit: boolean
}

function rowsOf(listing: readonly LegacyListingEntry[], options: LegacyImportOptions): Row[] {
  const byPath = new Map<string, LegacyListingEntry>()
  for (const entry of listing) byPath.set(relativePath(entry.path), entry)
  const implicit = new Set<string>()
  for (const path of byPath.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!byPath.has(dir)) implicit.add(dir)
    }
  }
  for (const dir of implicit) byPath.set(dir, { path: dir, isDir: true })
  const paths = [...byPath.keys()].sort()
  return paths.map((path) => {
    const entry = byPath.get(path) as LegacyListingEntry
    return {
      entry,
      implicit: implicit.has(path),
      parsed: parseLegacyPath(path, {
        isDir: entry.isDir,
        foreignModelNames: options.foreignModelNames,
      }),
    }
  })
}

const rootOf = (path: string, isDir: boolean): string => {
  const parts = path.split('/')
  return parts.length > 1 || isDir ? (parts[0] ?? ROOT_FILES) : ROOT_FILES
}

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')

// ── Numbers ─────────────────────────────────────────────────────────────────────────────

interface Unit {
  type: ItemTypeCode
  claimed: number
  effective: number
  key: string
  name: string
  locations: { path: string; resourceId: string | null }[]
  registry: RegistryClaim | null
  typo: boolean
  date: LegacyDate | null
  decision: NumberDecision
  assigned: number | null
  projected: number | null
  reason: string
}

function fullDate(date: LegacyDate | null): string | null {
  return date && date.year !== null && date.day !== null ? date.iso : null
}

/** Name of a numbered folder without its ID: the key that matches the registry. */
function unitKey(name: string, fragment: string): string {
  return looseKey(name.replace(fragment, ''))
}

function folderDate(parsed: ParsedLegacyPath): LegacyDate | null {
  const date = parsed.claims.find((c) => c.kind === 'date' && c.payload.date !== null)
  return date?.kind === 'date' ? date.payload.date : null
}

function collectUnits(rows: Row[]): Unit[] {
  const units = new Map<string, Unit>()
  const reservedAbove = new Set<string>()
  for (const { parsed, entry } of rows) {
    for (const claim of parsed.claims) {
      if (claim.kind !== 'number' || !claim.payload.reserves) continue
      const { type, number } = claim.payload
      // A file `[PPV-073]…` inside the folder `[PPV-073]…` is the same unit.
      const marker = `${type}:${number}`
      const parent = parentOf(parsed.path)
      if (reservedAbove.has(`${parent}|${marker}`)) {
        reservedAbove.add(`${parsed.path}|${marker}`)
        continue
      }
      reservedAbove.add(`${parsed.path}|${marker}`)
      const key = unitKey(parsed.name, claim.raw_fragment)
      const id = `${type}|${number}|${key}`
      const location = { path: parsed.path, resourceId: entry.resourceId ?? null }
      const existing = units.get(id)
      if (existing) {
        existing.locations.push(location)
        continue
      }
      units.set(id, {
        type,
        claimed: number,
        effective: number,
        key,
        name: parsed.name,
        locations: [location],
        registry: null,
        typo: false,
        date: folderDate(parsed),
        decision: 'keep',
        assigned: null,
        projected: null,
        reason: '',
      })
    }
  }
  return [...units.values()]
}

function linkRegistry(units: Unit[], registry: readonly RegistryClaim[]): Unit[] {
  const registryOnly: Unit[] = []
  const pending: RegistryClaim[] = []
  for (const row of registry) {
    const number = row.payload.number
    if (number === null) continue
    const parsed = parseLegacyName(row.payload.folder, { isDir: true })
    const id = parsed.find((c) => c.kind === 'number')
    const key = unitKey(row.payload.folder, id?.raw_fragment ?? '')
    const byName = units.filter((u) => u.type === 'PPV' && u.key === key && u.registry === null)
    if (byName.length > 0) {
      for (const unit of byName) {
        unit.registry = row
        if (unit.claimed !== number) {
          unit.typo = true
          unit.effective = number
        }
      }
      continue
    }
    pending.push(row)
  }
  for (const row of pending) {
    const number = row.payload.number as number
    const free = units.filter(
      (u) => u.type === 'PPV' && u.claimed === number && u.registry === null,
    )
    const sameNumber = units.filter((u) => u.type === 'PPV' && u.claimed === number)
    if (free.length === 1 && sameNumber.length === 1 && free[0]) {
      free[0].registry = row
      free[0].reason = 'имя в реестре расходится с папкой'
      continue
    }
    registryOnly.push({
      type: 'PPV',
      claimed: number,
      effective: number,
      key: `registry:${row.claim_key}`,
      name: row.payload.folder,
      locations: [],
      registry: row,
      typo: false,
      date: row.payload.folder_date,
      decision: 'unclear',
      assigned: null,
      projected: null,
      reason:
        sameNumber.length > 0
          ? 'строка реестра не совпала ни с одной папкой номера'
          : 'нет папки на диске',
    })
  }
  return registryOnly
}

interface CollisionGroup {
  units: Unit[]
  resolved: boolean
}

/** §6.4: the earliest by release date keeps the number, the rest renumber; no full dates — a person. */
function decide(units: Unit[]): CollisionGroup[] {
  const groups = new Map<string, Unit[]>()
  for (const unit of units) {
    const id = `${unit.type}|${unit.effective}`
    groups.set(id, [...(groups.get(id) ?? []), unit])
  }
  const collisions: CollisionGroup[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      const unit = group[0] as Unit
      unit.decision = unit.typo ? 'typo' : 'keep'
      unit.assigned = unit.effective
      if (unit.typo) unit.reason = 'опечатка номера: реестр называет эту папку другим номером'
      continue
    }
    const dated = group.map((u) => ({ unit: u, date: fullDate(u.date) }))
    const allDated = dated.every((d) => d.date !== null)
    const sorted = [...dated].sort((a, b) => byText(a.date ?? '', b.date ?? ''))
    const earliest = sorted[0]
    const resolved = Boolean(allDated && earliest && sorted[1] && earliest.date !== sorted[1].date)
    for (const { unit } of dated) {
      if (!resolved) {
        unit.decision = 'unclear'
        unit.assigned = null
        unit.reason = allDated ? 'одинаковая дата релиза' : 'у папки нет полной даты релиза'
      } else if (unit === earliest?.unit) {
        unit.decision = unit.typo ? 'typo' : 'keep'
        unit.assigned = unit.effective
        unit.reason = 'самая ранняя по дате релиза сохраняет номер'
      } else {
        unit.decision = 'renumber'
        unit.assigned = null
        unit.reason = 'номер занят более ранней папкой: следующий свободный номер при приёмке'
      }
    }
    collisions.push({ units: group, resolved })
  }
  return collisions
}

function collisionPlan(group: CollisionGroup): CollisionPlan {
  const first = group.units[0] as Unit
  const order = (u: Unit) => fullDate(u.date) ?? '9'
  return {
    type: first.type,
    number: first.effective,
    resolution: group.resolved ? 'earliest_keeps' : 'unclear',
    reason: group.resolved
      ? 'номер остаётся у самой ранней по дате релиза (SPEC §6.4)'
      : 'нельзя выбрать самую раннюю: решает человек',
    units: [...group.units]
      .sort((a, b) => byText(order(a), order(b)) || byText(a.name, b.name))
      .map(unitPlan),
  }
}

function unitPlan(unit: Unit): CollisionUnitPlan {
  return {
    name: unit.name,
    paths: unit.locations.map((l) => l.path),
    registryRow: unit.registry?.payload.row ?? null,
    releaseDate: fullDate(unit.date),
    decision: unit.decision,
    assignedNumber: unit.assigned,
    projectedNumber: unit.projected,
  }
}

function sextingEvidence(
  rows: Row[],
  albums: readonly VaultAlbumEvidence[],
): { plans: SextingEvidencePlan[]; units: Unit[] } {
  const sortedAlbums = [...albums].sort(
    (a, b) => byText(a.source, b.source) || byText(a.title, b.title),
  )
  const plans: SextingEvidencePlan[] = []
  const units: Unit[] = []
  for (const number of SXT_EVIDENCE_NUMBERS) {
    const evidence: { source: string; text: string }[] = []
    for (const { parsed } of rows) {
      for (const claim of parsed.claims) {
        if (
          claim.kind === 'number' &&
          claim.payload.type === 'SXT' &&
          claim.payload.number === number
        ) {
          evidence.push({ source: parsed.context.archive ? 'archive' : 'path', text: parsed.path })
        }
      }
    }
    const fromPaths = evidence.length > 0
    for (const album of sortedAlbums) {
      const named = findIdMentions(album.title, { spoken: true }).some(
        (m) => m.type === 'SXT' && m.number === number,
      )
      if (!named) continue
      evidence.push({ source: album.source, text: album.title })
      // A folder already claims the number; the album only corroborates it.
      if (fromPaths || units.some((u) => u.claimed === number)) continue
      units.push({
        type: 'SXT',
        claimed: number,
        effective: number,
        key: `vault:${album.source}`,
        name: album.title,
        locations: [],
        registry: null,
        typo: false,
        date: null,
        decision: 'keep',
        assigned: number,
        projected: null,
        reason: 'название альбома vault называет номер',
      })
    }
    plans.push({ number, status: evidence.length > 0 ? 'reserve' : 'hole', evidence })
  }
  return { plans, units }
}

function reserveOf(
  units: Unit[],
  current: Partial<Record<ItemTypeCode, number>>,
): CounterReservePlan[] {
  return ITEM_TYPE_CODES.map((type) => {
    const claimed = new Set<number>()
    for (const unit of units) {
      if (unit.type !== type) continue
      claimed.add(unit.claimed)
      claimed.add(unit.effective)
    }
    const max = claimed.size > 0 ? Math.max(...claimed) : null
    const now = current[type] ?? null
    const next = Math.max(now ?? 1, max === null ? 1 : max + 1)
    const holes: number[] = []
    if (max !== null) for (let n = 1; n < max; n++) if (!claimed.has(n)) holes.push(n)
    return { type, maxClaimed: max, current: now, next, holes }
  }).filter((r) => r.maxClaimed !== null || r.current !== null)
}

function project(units: Unit[], reserve: CounterReservePlan[]): void {
  for (const r of reserve) {
    let next = r.next
    const renumber = units
      .filter((u) => u.type === r.type && u.decision === 'renumber')
      .sort(
        (a, b) =>
          byText(fullDate(a.date) ?? '9', fullDate(b.date) ?? '9') ||
          a.claimed - b.claimed ||
          byText(a.name, b.name),
      )
    for (const unit of renumber) unit.projected = next++
  }
}

function numberClaimsOf(units: Unit[]): NumberClaimPlan[] {
  const out: NumberClaimPlan[] = []
  for (const unit of units) {
    const base = {
      type: unit.type,
      registryRow: unit.registry?.payload.row ?? null,
      decision: unit.decision,
      assignedNumber: unit.assigned,
      projectedNumber: unit.projected,
      releaseDate: fullDate(unit.date),
      reason: unit.reason,
    }
    for (const location of unit.locations) {
      out.push({ ...base, claimedNumber: unit.claimed, source: { kind: 'path', ...location } })
    }
    if (unit.registry) {
      out.push({
        ...base,
        claimedNumber: unit.registry.payload.number ?? unit.effective,
        source: {
          kind: 'registry',
          row: unit.registry.payload.row,
          folder: unit.registry.payload.folder,
          claimKey: unit.registry.claim_key,
        },
      })
    }
    if (unit.locations.length === 0 && !unit.registry) {
      out.push({
        ...base,
        claimedNumber: unit.claimed,
        source: { kind: 'evidence', text: unit.name, source: unit.key.replace(/^vault:/, '') },
      })
    }
  }
  return out.sort(
    (a, b) =>
      byText(a.type, b.type) ||
      a.claimedNumber - b.claimedNumber ||
      byText(sourceText(a.source), sourceText(b.source)),
  )
}

const sourceText = (s: NumberClaimSource): string =>
  s.kind === 'path' ? `1:${s.path}` : s.kind === 'registry' ? `2:${s.row}` : `3:${s.text}`

// ── Labels, unparsed, sections ──────────────────────────────────────────────────────────

function labelsOf(rows: Row[], limit: number): LabelPlan[] {
  const labels = new Map<string, LabelPlan>()
  for (const { parsed } of rows) {
    for (const claim of parsed.claims) {
      if (claim.kind !== 'used' && claim.kind !== 'posted') continue
      const usage = claim as ClaimOf<'used'> | ClaimOf<'posted'>
      const { label } = usage.payload
      const plan = labels.get(label) ?? {
        label,
        kind: usage.kind,
        proposedAccount: usage.payload.account,
        count: 0,
        withDate: 0,
        withoutDate: 0,
        examples: [],
      }
      plan.count++
      if (usage.payload.date) plan.withDate++
      else plan.withoutDate++
      if (plan.examples.length < limit && !plan.examples.includes(parsed.path)) {
        plan.examples.push(parsed.path)
      }
      labels.set(label, plan)
    }
  }
  return [...labels.values()].sort((a, b) => b.count - a.count || byText(a.label, b.label))
}

function oldFormatOf(rows: Row[]): OldFormatPlan[] {
  const folders = new Map<string, OldFormatPlan>()
  for (const { parsed, entry, implicit } of rows) {
    if (parsed.context.area !== 'old_format' || parsed.context.archive) continue
    const parts = parsed.path.split('/')
    if (parts.length < 2) continue
    const folder = parts.length > 2 || parsed.isDir ? (parts[1] ?? '') : ROOT_FILES
    const plan = folders.get(folder) ?? {
      folder,
      files: 0,
      dirs: 0,
      bytes: 0,
      numberAliases: [],
      labels: 0,
      unknownFragments: 0,
    }
    if (parsed.isDir) {
      if (!implicit) plan.dirs++
    } else {
      plan.files++
      plan.bytes += entry.size ?? 0
    }
    for (const claim of parsed.claims) {
      if (claim.kind === 'number') {
        plan.numberAliases.push({
          type: claim.payload.type,
          number: claim.payload.number,
          path: parsed.path,
        })
      }
      if (claim.kind === 'used' || claim.kind === 'posted') plan.labels++
      if (claim.kind === 'unknown') plan.unknownFragments++
    }
    folders.set(folder, plan)
  }
  return [...folders.values()].sort((a, b) => byText(a.folder, b.folder))
}

function smmFoldersOf(rows: Row[]): SmmFolderPlan[] {
  const folders = new Map<string, SmmFolderPlan>()
  for (const { parsed, entry } of rows) {
    if (parsed.isDir || parsed.context.archive) continue
    const { area, promoChannel } = parsed.context
    const parent = parentOf(parsed.path)
    const depth = parent.split('/').length
    const smm = area === 'smm' && depth >= 2
    if (!smm && !promoChannel) continue
    const plan = folders.get(parent) ?? {
      path: parent,
      channel: promoChannel,
      files: 0,
      bytes: 0,
      firstUpload: null,
      lastUpload: null,
      mark: 'пак подрядчику или съёмка вендора — отметить' as const,
    }
    plan.files++
    plan.bytes += entry.size ?? 0
    const at = entry.createdAt ?? null
    if (at && (plan.firstUpload === null || at < plan.firstUpload)) plan.firstUpload = at
    if (at && (plan.lastUpload === null || at > plan.lastUpload)) plan.lastUpload = at
    folders.set(parent, plan)
  }
  return [...folders.values()].sort((a, b) => byText(a.path, b.path))
}

function archivesOf(rows: Row[]): ArchivePlan[] {
  const members = new Map<string, number>()
  for (const { entry } of rows) {
    const archive = entry.archiveEntry?.archivePath
    if (archive) {
      const key = relativePath(archive)
      members.set(key, (members.get(key) ?? 0) + 1)
    }
  }
  return rows
    .filter(({ parsed }) => parsed.context.isArchive)
    .map(({ parsed, entry }) => ({
      path: parsed.path,
      bytes: entry.size ?? null,
      foreignModel: parsed.context.foreignModel,
      entriesListed: members.get(parsed.path) ?? 0,
      incomplete: entry.incomplete === true,
    }))
}

function duplicatesOf(rows: Row[]): DuplicatePlan[] {
  const groups = new Map<string, DuplicatePlan>()
  for (const { entry, parsed } of rows) {
    if (parsed.isDir) continue
    const hashKind = entry.sha256 ? 'sha256' : entry.md5 ? 'md5' : null
    const hash = entry.sha256 ?? entry.md5
    if (!hashKind || !hash) continue
    const key = `${hashKind}:${hash.toLowerCase()}`
    const group = groups.get(key) ?? {
      hash: hash.toLowerCase(),
      hashKind,
      size: entry.size ?? null,
      paths: [],
    }
    group.paths.push(parsed.path)
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((g) => g.paths.length > 1)
    .sort((a, b) => byText(a.paths[0] ?? '', b.paths[0] ?? ''))
}

function coverageOf(rows: Row[]): CoveragePlan {
  const listed = rows.filter((r) => !r.implicit)
  const unknownByRoot: Record<string, number> = {}
  let unknownFragments = 0
  for (const { parsed } of listed) {
    const unknown = parsed.claims.filter((c) => c.kind === 'unknown').length
    if (unknown === 0) continue
    unknownFragments += unknown
    const root = rootOf(parsed.path, parsed.isDir)
    unknownByRoot[root] = (unknownByRoot[root] ?? 0) + unknown
  }
  return {
    entries: listed.length,
    files: listed.filter((r) => !r.parsed.isDir).length,
    dirs: listed.filter((r) => r.parsed.isDir).length,
    withClaim: listed.filter((r) => r.parsed.claims.some((c) => c.kind !== 'unknown')).length,
    withoutUnknown: listed.filter((r) => r.parsed.claims.every((c) => c.kind !== 'unknown')).length,
    unknownFragments,
    unknownByRoot,
  }
}

// ── The plan ────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot listing → the dry-run report. Deterministic: the same listing, options and parser
 * version give the same report regardless of the listing order.
 */
export function planLegacyImport(
  listing: readonly LegacyListingEntry[],
  options: LegacyImportOptions = {},
): LegacyImportPlan {
  const rows = rowsOf(listing, options)
  const units = collectUnits(rows)
  const registryOnly = linkRegistry(units, options.registry ?? [])
  const sextings = sextingEvidence(rows, options.vaultAlbums ?? [])
  const all = [...units, ...registryOnly, ...sextings.units]
  const groups = decide([...units, ...sextings.units])
  const reserve = reserveOf(all, options.currentCounters ?? {})
  project(all, reserve)
  const collisions = groups
    .map(collisionPlan)
    .sort((a, b) => byText(a.type, b.type) || a.number - b.number)
  const typos: TypoPlan[] = units
    .filter((u) => u.typo && u.registry)
    .map((u) => ({
      type: u.type,
      name: u.name,
      paths: u.locations.map((l) => l.path),
      claimedNumber: u.claimed,
      registryNumber: u.effective,
      registryRow: u.registry?.payload.row ?? 0,
    }))
  const unparsed: UnparsedPlan[] = rows
    .filter((r) => !r.implicit)
    .map(({ parsed }) => ({
      path: parsed.path,
      isDir: parsed.isDir,
      fragments: parsed.claims.filter((c) => c.kind === 'unknown').map((c) => c.raw_fragment),
    }))
    .filter((u) => u.fragments.length > 0)

  return {
    parserVersion: PARSER_VERSION,
    entries: rows.map((r) => r.parsed),
    numberClaims: numberClaimsOf(all),
    collisions,
    typos,
    reserve,
    sextings: sextings.plans,
    labels: labelsOf(rows, options.exampleLimit ?? 5),
    unparsed,
    oldFormat: oldFormatOf(rows),
    smmFolders: smmFoldersOf(rows),
    archives: archivesOf(rows),
    duplicates: duplicatesOf(rows),
    incompleteInputs: rows.filter((r) => r.entry.incomplete).map((r) => r.parsed.path),
    coverage: coverageOf(rows),
  }
}
