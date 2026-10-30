import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config'

const WEB = {
  ROLE: 'web',
  DATABASE_URL: 'postgres://app:s3cret@db:5432/contentops',
  DATA_ROOT: '/srv/content',
  DERIVED_ROOT: '/srv/derived',
  TMP_ROOT: '/srv/tmp',
  PUBLIC_URL: 'https://contentops.example.test',
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('config was accepted')
}

describe('loadConfig', () => {
  it('fills defaults: loopback, port 3000, no mounts, the pilot limits', () => {
    expect(loadConfig(WEB)).toMatchObject({
      ROLE: 'web',
      HOST: '127.0.0.1',
      PORT: 3000,
      TRUSTED_PROXY: ['loopback'],
      REQUIRE_MOUNTS: [],
      ENCODE_JOBS: 1,
      COPY_JOBS: 1,
    })
  })

  it('starts without secrets of integrations', () => {
    const config = loadConfig(WEB)
    expect(config.YDISK_TOKEN).toBeUndefined()
    expect(config.HUB_API_KEY).toBeUndefined()
  })

  it('reads lists and numbers', () => {
    const config = loadConfig({
      ...WEB,
      PORT: '8080',
      REQUIRE_MOUNTS: '/srv/derived, /srv/tmp,',
      TRUSTED_PROXY: 'loopback,10.0.0.0/8',
      FETCH_AHEAD_GB: '12.5',
    })
    expect(config.PORT).toBe(8080)
    expect(config.REQUIRE_MOUNTS).toEqual(['/srv/derived', '/srv/tmp'])
    expect(config.TRUSTED_PROXY).toEqual(['loopback', '10.0.0.0/8'])
    expect(config.FETCH_AHEAD_GB).toBe(12.5)
  })

  it('names what a role lacks; an empty value counts as missing', () => {
    expect(problemsOf({ ...WEB, DATABASE_URL: '', PUBLIC_URL: undefined })).toEqual([
      'DATABASE_URL: нужна для роли web',
      'PUBLIC_URL: нужна для роли web',
    ])
    expect(problemsOf({ ROLE: 'migrate' })).toEqual([
      'MIGRATE_DATABASE_URL: нужна для роли migrate',
    ])
    expect(loadConfig({ ROLE: 'migrate', MIGRATE_DATABASE_URL: WEB.DATABASE_URL }).ROLE).toBe(
      'migrate',
    )
  })

  it('rejects bad values without echoing them', () => {
    const env = {
      ...WEB,
      ROLE: 'web',
      PORT: 'eighty',
      DATA_ROOT: 'content',
      DATABASE_URL: 'mysql://app:s3cret@db/contentops',
      REQUIRE_MOUNTS: '/srv/derived,tmp',
    }
    const problems = problemsOf(env)
    expect(problems.map((line) => line.split(':')[0])).toEqual([
      'PORT',
      'DATABASE_URL',
      'DATA_ROOT',
      'REQUIRE_MOUNTS.1',
    ])
    expect(problems.join('\n')).not.toContain('s3cret')
    expect(problemsOf({ ROLE: 'scheduler' })[0]).toMatch(/^ROLE: /)
  })

  it('gives one readable message', () => {
    expect(() => loadConfig({ ROLE: 'web' })).toThrow(
      /Неверная конфигурация окружения:\n {2}DATABASE_URL/,
    )
  })
})
