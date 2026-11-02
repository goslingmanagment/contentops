import { describe, expect, it } from 'vitest'
import { DEFAULT_PLATFORM_PROFILE, platformRecipe } from './copies.ts'
import { videoDerivativeRecipes } from './derive-video.ts'
import { copyHdrRecipe } from './hdr.ts'
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

  it('stays as it was for the existing library: a change here rebuilds it (≈ 1 800 files)', () => {
    expect(digests(FAKE_VERSIONS)).toEqual({
      master: '4a5dc7ea91aeb0a481fdebaed851c718200c0c717cc220a1d4f1c65ee7a94640',
      platform: 'd203d1a1b87b98f1725be39666053a200e54e883d9ec7d7ca74267c750145131',
      'video.preview': '764ebc639ade512946e415b9cd300b762a1d4281a262945975a49a1b050f5cdc',
      'video.poster': 'b74aaf45452b8040acecb6f3ee4395fcc597fa9ca5051dd438261c3a1febe79b',
      'video.thumb320': '2636f4cd2c7f8e162c65c02bacdc6760f6e11a0f4461769c0c5e428ed07437d9',
      'video.thumb640': 'e4271bc372e4ddcf6ca7592cbcdfd1db3946b2c439dd3fc7865e29758e1020b9',
      'video.frames': 'cee6d86f1b8dae643e1300d8088f5d0a720b3ea66f8deb38266b51e15c2515af',
      'photo.preview2048': '6ecec8794bedb6315bdff72af53ad37df6389041fa241f5bbe2424c9e9757511',
      'photo.thumb640': '1b301b7d3bbc30012233e5cf192e11eac9417693786c2195ee3eabc4fba7e29c',
      'photo.thumb320': 'ab2a89499741f0693836a723d0a259cd12d17f9dc08cfad0c7f0450ab4c5e64c',
      'photo.frames': 'dbd7a880093cd8f9b42f8fd729a196873cded57ec196d643aed707c003005ec9',
      'photo.phash': '648c23eaf4f730675c29139db17d508d570073899f61ae67a84790faba8c78ad',
      'photo.probe': 'd582796df31b963d68c63cffe6e55d8046d50c3f23615037076b2caeff5dfa56',
    })
  })

  it('of a copy from an HDR source is its own: SDR copies stay valid', () => {
    const sdr = platformRecipe(FAKE_VERSIONS, DEFAULT_PLATFORM_PROFILE, false)
    const hdr = platformRecipe(FAKE_VERSIONS, DEFAULT_PLATFORM_PROFILE, false, true)
    expect(hdr.digest).not.toBe(sdr.digest)
    expect(hdr.recipe.profile).toMatchObject({ hdr: copyHdrRecipe() })
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
