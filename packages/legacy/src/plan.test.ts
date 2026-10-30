import { describe, expect, it } from 'vitest'
import { FIXTURE_DISK, FIXTURE_REGISTRY } from './fixture.ts'
import { type LegacyListingEntry, planLegacyImport } from './plan.ts'
import { parsePpvRegistry } from './registry.ts'

const registry = parsePpvRegistry(FIXTURE_REGISTRY)
const plan = (listing: LegacyListingEntry[] = FIXTURE_DISK, extra = {}) =>
  planLegacyImport(listing, { registry, foreignModelNames: ['Bea'], ...extra })

const claimsOf = (p: ReturnType<typeof plan>, number: number) =>
  p.numberClaims.filter((c) => c.type === 'PPV' && c.claimedNumber === number)

const folderDecision = (p: ReturnType<typeof plan>, fragment: string) =>
  p.numberClaims.find((c) => c.source.kind === 'path' && c.source.path.includes(fragment))

describe('PPV collisions (SPEC §6.4)', () => {
  const p = plan()

  it('023: the earliest by release date keeps the number, the other renumbers', () => {
    expect(folderDecision(p, 'paint_body')).toMatchObject({ decision: 'keep', assignedNumber: 23 })
    expect(folderDecision(p, 'ribbon_play')).toMatchObject({
      decision: 'renumber',
      assignedNumber: null,
    })
    const collision = p.collisions.find((c) => c.number === 23)
    expect(collision).toMatchObject({ type: 'PPV', resolution: 'earliest_keeps' })
    expect(collision?.units.map((u) => u.decision)).toEqual(['keep', 'renumber'])
  })

  it('032: three folders, the earliest keeps, two get the next numbers after the reserve', () => {
    expect(folderDecision(p, 'cocoa_cup')).toMatchObject({ decision: 'keep', assignedNumber: 32 })
    // Live counter after the reserve 73, in order of release date: pumpkin, tweed, then 023's ribbon.
    expect(folderDecision(p, 'pumpkin_night')).toMatchObject({
      decision: 'renumber',
      projectedNumber: 73,
    })
    expect(folderDecision(p, 'tweed_suit')).toMatchObject({
      decision: 'renumber',
      projectedNumber: 74,
    })
    expect(folderDecision(p, 'ribbon_play')).toMatchObject({ projectedNumber: 75 })
    expect(claimsOf(p, 32).filter((c) => c.source.kind === 'path')).toHaveLength(3)
    expect(claimsOf(p, 32).filter((c) => c.source.kind === 'registry')).toHaveLength(3)
  })

  it('066/067: the shimmer-like folder is a typo — the registry number wins, 066 stays', () => {
    expect(folderDecision(p, 'glitter_Teasing')).toMatchObject({
      claimedNumber: 66,
      decision: 'typo',
      assignedNumber: 67,
    })
    expect(folderDecision(p, 'rope_stretch_6min')).toMatchObject({
      decision: 'keep',
      assignedNumber: 66,
    })
    expect(p.typos).toEqual([
      expect.objectContaining({ claimedNumber: 66, registryNumber: 67, registryRow: 10 }),
    ])
    expect(p.collisions.some((c) => c.number === 66 || c.number === 67)).toBe(false)
  })

  it('070–072 are only on the disk and keep their numbers; the counter starts at 073', () => {
    for (const n of [70, 71, 72]) {
      expect(claimsOf(p, n)).toEqual([
        expect.objectContaining({ decision: 'keep', assignedNumber: n, registryRow: null }),
      ])
    }
    expect(p.reserve.find((r) => r.type === 'PPV')).toMatchObject({ maxClaimed: 72, next: 73 })
  })

  it('every registry row is linked to its folder', () => {
    const registryClaims = p.numberClaims.filter((c) => c.source.kind === 'registry')
    expect(registryClaims).toHaveLength(registry.length)
    expect(registryClaims.every((c) => c.decision !== 'unclear')).toBe(true)
  })

  it('the reserve goes only up: a counter already above the max stays', () => {
    const higher = plan(FIXTURE_DISK, { currentCounters: { PPV: 90 } })
    expect(higher.reserve.find((r) => r.type === 'PPV')).toMatchObject({ current: 90, next: 90 })
    expect(folderDecision(higher, 'pumpkin_night')?.projectedNumber).toBe(90)
  })

  it('two folders without a full release date stay unclear for a person', () => {
    const listing: LegacyListingEntry[] = [
      { path: '1. PPV/Bundles/[PPV-040]_amber_X.X.X', isDir: true },
      { path: '1. PPV/Bundles/[PPV-040]_onyx_12.03.2026', isDir: true },
    ]
    const q = planLegacyImport(listing)
    expect(q.collisions).toEqual([expect.objectContaining({ number: 40, resolution: 'unclear' })])
    expect(q.numberClaims.map((c) => c.decision)).toEqual(['unclear', 'unclear'])
  })

  it('a registry row without a folder reserves its number and waits for a person', () => {
    const q = planLegacyImport([], { registry })
    expect(q.reserve.find((r) => r.type === 'PPV')?.next).toBe(70)
    expect(
      q.numberClaims.every((c) => c.decision === 'unclear' && c.source.kind === 'registry'),
    ).toBe(true)
  })

  it('a numbered folder anywhere reserves, also inside «Старый формат» and archives', () => {
    const q = planLegacyImport([
      { path: 'Старый формат/PPV/[PPV-080]_old_copy_01.01.2025', isDir: true },
      {
        path: 'Archive.zip/[PPV-081]_zip_copy_02.01.2025/full.mov',
        isDir: false,
        archiveEntry: { archivePath: 'Archive.zip', entryNo: 1 },
      },
      { path: 'Archive.zip', isDir: false },
    ])
    expect(q.reserve.find((r) => r.type === 'PPV')).toMatchObject({ maxClaimed: 81, next: 82 })
  })

  it('old-format numbers are aliases only and reserve nothing', () => {
    const old = p.numberClaims.filter(
      (c) => c.source.kind === 'path' && c.source.path.startsWith('Старый'),
    )
    expect(old).toEqual([])
    expect(p.oldFormat.find((f) => f.folder === 'PPV')?.numberAliases).toEqual([
      expect.objectContaining({ type: 'PPV', number: 16 }),
      expect.objectContaining({ type: 'PPV', number: 1 }),
    ])
  })
})

describe('SXT-010/011 (SPEC §6.4)', () => {
  it('without a source naming them they stay holes', () => {
    const p = plan()
    expect(p.sextings).toEqual([
      { number: 10, status: 'hole', evidence: [] },
      { number: 11, status: 'hole', evidence: [] },
    ])
    expect(p.reserve.find((r) => r.type === 'SXT')).toMatchObject({
      maxClaimed: 12,
      next: 13,
      holes: [3, 4, 5, 6, 7, 8, 10, 11],
    })
  })

  it('a name inside the archive or a vault album reserves them', () => {
    const listing: LegacyListingEntry[] = [
      ...FIXTURE_DISK,
      {
        path: '5. Sextings/sexting feb.zip/sexting_010_satin_robe/1.jpg',
        isDir: false,
        archiveEntry: { archivePath: '5. Sextings/sexting feb.zip', entryNo: 0 },
      },
    ]
    const p = plan(listing, {
      vaultAlbums: [{ title: 'S11 Satin robe 2', source: 'hub:fansly:album-77' }],
    })
    expect(p.sextings).toEqual([
      {
        number: 10,
        status: 'reserve',
        evidence: [
          { source: 'archive', text: '5. Sextings/sexting feb.zip/sexting_010_satin_robe' },
        ],
      },
      {
        number: 11,
        status: 'reserve',
        evidence: [{ source: 'hub:fansly:album-77', text: 'S11 Satin robe 2' }],
      },
    ])
    expect(p.reserve.find((r) => r.type === 'SXT')?.holes).not.toContain(10)
    expect(p.numberClaims).toContainEqual(
      expect.objectContaining({
        type: 'SXT',
        claimedNumber: 11,
        decision: 'keep',
        source: expect.objectContaining({ kind: 'evidence' }),
      }),
    )
    expect(p.archives.find((a) => a.path === '5. Sextings/sexting feb.zip')?.entriesListed).toBe(1)
  })
})

describe('the rest of the dry-run report', () => {
  const p = plan()

  it('labels for the КМ with examples and the proposed page', () => {
    const used2 = p.labels.find((l) => l.label === 'used2')
    expect(used2).toMatchObject({ kind: 'used', proposedAccount: { kind: 'index', index: 2 } })
    expect(used2?.examples.length).toBeGreaterThan(0)
    expect(p.labels.find((l) => l.label === 'posted_folder')).toMatchObject({
      proposedAccount: { kind: 'unknown' },
    })
    expect(p.labels.find((l) => l.label === 'used_all')?.proposedAccount).toEqual({ kind: 'all' })
  })

  it('unparsed names keep the raw fragment', () => {
    expect(p.unparsed).toEqual([
      {
        path: '2. FYP/Posted/August 2025 (posted)/posted/al_used_all).MOV',
        isDir: false,
        fragments: ['al'],
      },
    ])
  })

  it('SMM folders are listed for marking, camera dumps are not', () => {
    expect(p.smmFolders.map((f) => [f.path, f.channel, f.files])).toEqual([
      ['9. SMM/Twitter/zenpromo june/photos', 'Twitter', 2],
      ['9. SMM/YT/Mirko/декабрь - ASMR - 6 видео /1 video', 'YT', 1],
    ])
    expect(p.smmFolders[0]).toMatchObject({
      firstUpload: '2025-06-02T10:00:00+00:00',
      mark: 'пак подрядчику или съёмка вендора — отметить',
    })
  })

  it('«Старый формат» is summarised by its folders', () => {
    expect(p.oldFormat.map((f) => [f.folder, f.files, f.dirs, f.bytes, f.labels])).toEqual([
      ['FYP', 1, 1, 500, 1],
      ['PPV', 2, 2, 9000, 2],
      ['Sets', 0, 2, 0, 0],
    ])
  })

  it('archives, the foreign one parked; exact duplicates grouped', () => {
    expect(p.archives.map((a) => [a.path, a.foreignModel])).toEqual([
      ['5. Sextings/sexting feb.zip', null],
      ['Bea FYP — монтаж (КМ) — 2026-08-18.zip', 'Bea'],
      ['archive-2025-11-04_01-02-03.zip', null],
    ])
    expect(p.duplicates.map((d) => d.paths)).toEqual([
      ['1. PPV/Bundles/[PPV-072]_quick_tease_sun_30.07.26/IMG_7707.mov', 'IMG_7707.mov'],
      [
        '1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/Растяжка и верёвка.mov',
        '3. Customs/отобранное на PPV/Растяжка и верёвка.mov',
      ],
    ])
  })

  it('coverage counts listed entries only', () => {
    expect(p.coverage).toMatchObject({
      entries: FIXTURE_DISK.length,
      unknownFragments: 1,
      unknownByRoot: { '2. FYP': 1 },
    })
    expect(p.coverage.withoutUnknown).toBe(FIXTURE_DISK.length - 1)
  })

  it('incomplete inputs are listed and do not block', () => {
    const q = plan([...FIXTURE_DISK, { path: '9. SMM/Unreadable', isDir: true, incomplete: true }])
    expect(q.incompleteInputs).toEqual(['9. SMM/Unreadable'])
  })
})

describe('determinism', () => {
  it('the same listing in another order gives the same report', () => {
    const shuffled = [...FIXTURE_DISK].reverse()
    expect(JSON.stringify(plan(shuffled))).toBe(JSON.stringify(plan()))
  })

  it('a repeat gives the same claim keys; a rename gives new ones', () => {
    const a = plan().entries.flatMap((e) => e.claims.map((c) => c.claim_key))
    const b = plan().entries.flatMap((e) => e.claims.map((c) => c.claim_key))
    expect(a).toEqual(b)
    const renamed = planLegacyImport([
      { path: '2. FYP/August 2026/used3_04.08.26_used2_31.07.26 .mov', isDir: false },
    ])
    const original = planLegacyImport([
      { path: '2. FYP/August 2026/used3_04.08.26_used2_31.07.26.mov', isDir: false },
    ])
    const keys = (q: typeof original) =>
      q.entries.filter((e) => !e.isDir).flatMap((e) => e.claims.map((c) => c.claim_key))
    expect(keys(renamed).some((k) => keys(original).includes(k))).toBe(false)
  })
})
