import { describe, expect, it } from 'vitest'
import { isOwnPath, loginSearchSchema } from './search'

// Та же таблица, что у сервера (`ownPath`), хаба, TaskIndex и монитора (ecosystem R9).
describe('куда вести после входа (`from`)', () => {
  it('только на свой путь и после нормализации', () => {
    for (const from of [
      'https://evil.example/',
      '//evil.example/',
      '/.//evil.example/x',
      '/%2F/evil.example/x',
      '/\\evil.example',
      '/%5Cevil.example',
      '/./x',
      '/../x',
      '/%2e%2e/x',
    ]) {
      expect(isOwnPath(from), from).toBe(false)
      expect(loginSearchSchema.parse({ from }).from, from).toBeUndefined()
    }
    expect(loginSearchSchema.parse({ from: '/lora/library?kind=dm#top' }).from).toBe(
      '/lora/library?kind=dm#top',
    )
  })
})
