import { describe, expect, it } from 'vitest'
import { DEFAULT_PLATFORM_PROFILE, platformRecipe } from './copies.ts'
import { videoDerivativeRecipes } from './derive-video.ts'
import { masterRecipe } from './master.ts'
import { photoRecipes } from './photo.ts'
import { canonicalJson, recipeDigest } from './recipe.ts'
import { FAKE_VERSIONS } from './testing/helpers.ts'
import type { ToolVersions } from './tools.ts'

function digests(v: ToolVersions): Record<string, string> {
  const video = videoDerivativeRecipes(v)
  const photo = photoRecipes(v)
  const out: Record<string, string> = {
    master: masterRecipe(v, 4).digest,
    platform: platformRecipe(v, DEFAULT_PLATFORM_PROFILE, false).digest,
  }
  for (const [k, r] of Object.entries(video)) out[`video.${k}`] = r.digest
  for (const [k, r] of Object.entries(photo)) out[`photo.${k}`] = r.digest
  return out
}

function changedKinds(change: Partial<ToolVersions>): string[] {
  const before = digests(FAKE_VERSIONS)
  const after = digests({ ...FAKE_VERSIONS, ...change })
  return Object.keys(before)
    .filter((k) => before[k] !== after[k])
    .sort()
}

describe('canonical JSON', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    )
  })
  it('rejects values JSON cannot keep', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
  })
})

describe('recipe_digest', () => {
  it('is distinct for every kind, photo and video thumbnails included', () => {
    const all = Object.values(digests(FAKE_VERSIONS))
    expect(new Set(all).size).toBe(all.length)
  })

  it('is stable for the same recipe and versions', () => {
    expect(digests(FAKE_VERSIONS)).toEqual(digests({ ...FAKE_VERSIONS }))
  })

  it('changes only for the kinds built by the changed tool', () => {
    expect(changedKinds({ svtav1: 'v4.3.0' })).toEqual(['master'])
    expect(changedKinds({ phash: 'sharp-phash@2.3.0' })).toEqual(['photo.phash'])
    expect(changedKinds({ libheif: '1.24.0' })).toEqual([
      'photo.frames',
      'photo.phash',
      'photo.preview2048',
      'photo.probe',
      'photo.thumb320',
      'photo.thumb640',
    ])
    // Video stills are WebP from sharp, so libvips rebuilds them but not the preview.
    expect(changedKinds({ libvips: '8.17.0' })).toEqual([
      'photo.frames',
      'photo.phash',
      'photo.preview2048',
      'photo.probe',
      'photo.thumb320',
      'photo.thumb640',
      'video.frames',
      'video.poster',
      'video.thumb320',
      'video.thumb640',
    ])
    expect(changedKinds({ ffmpeg: 'n8.1.3' })).toEqual([
      'master',
      'platform',
      'video.frames',
      'video.poster',
      'video.preview',
      'video.thumb320',
      'video.thumb640',
    ])
  })

  it('changes with its own profile only', () => {
    const base = platformRecipe(FAKE_VERSIONS, DEFAULT_PLATFORM_PROFILE, false)
    const stripped = platformRecipe(FAKE_VERSIONS, DEFAULT_PLATFORM_PROFILE, true)
    const measured = platformRecipe(FAKE_VERSIONS, { ...DEFAULT_PLATFORM_PROFILE, crf: 22 }, false)
    expect(new Set([base.digest, stripped.digest, measured.digest]).size).toBe(3)
    expect(masterRecipe(FAKE_VERSIONS, 6).digest).not.toBe(masterRecipe(FAKE_VERSIONS, 4).digest)
    const thumb = videoDerivativeRecipes(FAKE_VERSIONS).thumb320
    const edited = {
      ...thumb.recipe,
      profile: { ...(thumb.recipe.profile as object), webp: { quality: 70 } },
    }
    expect(recipeDigest(edited)).not.toBe(thumb.digest)
    expect(videoDerivativeRecipes(FAKE_VERSIONS).preview.digest).toBe(
      videoDerivativeRecipes(FAKE_VERSIONS).preview.digest,
    )
  })
})
