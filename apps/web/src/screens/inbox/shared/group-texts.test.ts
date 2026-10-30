import { mskInstant } from '@contentops/contracts'
import { buildCasesInbox } from '@contentops/mock-api/fixtures/lora-inbox-cases'
import { describe, expect, it } from 'vitest'
import { bytesOf, groupStateView, metaLine } from './group-texts'

const groups = new Map(buildCasesInbox().map((record) => [record.group.id, record.group]))
const channelName = (id: string) => (id === 'instagram' ? 'Instagram' : id)
const now = mskInstant('2026-09-22', '14:20')

function stateText(id: string, detailed = false): string {
  const group = groups.get(id)
  if (!group) {
    throw new Error(`В фикстурах нет группы ${id}`)
  }
  return groupStateView(group, channelName, detailed).text
}

describe('слова «Приехало»', () => {
  it('ход скачивания — одна цифра после запятой и единица один раз', () => {
    expect(bytesOf(3_200_000_000, 5_800_000_000)).toBe('3,2 из 5,8 ГБ')
    expect(bytesOf(3_264_000_000, 5_800_000_000)).toBe('3,2 из 5,8 ГБ')
    expect(bytesOf(12_000_000, 104_000_000)).toBe('12 МБ из 104 МБ')
  })

  it('готовится: «качается 3,2 из 5,8 ГБ», «сжимается 62 %», «проверяется»', () => {
    expect(stateText('g-archive')).toBe('качается 3,2 из 5,8 ГБ')
    // Между числом и знаком процента — неразрывный пробел.
    expect(stateText('g-ppv-short')).toBe('сжимается 62\u00a0%')
    expect(stateText('g-web-videos')).toBe('проверяется')
  })

  it('готово с тем, что добавляет норма: в панели полностью, на плитке — уточнение', () => {
    expect(stateText('g-set074-plus3', true)).toBe('готово · дополнит SET-074')
    expect(stateText('g-341', true)).toBe('готово · похоже на исправление CUS-195')
    expect(stateText('g-kp3', true)).toBe('готово · Промо: Instagram')
    expect(stateText('g-life-coffee', true)).toBe('готово · изменён после снимка')
    expect(stateText('g-set074-plus3')).toBe('дополнит SET-074')
    expect(stateText('g-341')).toBe('исправление CUS-195')
    expect(stateText('g-kp3')).toBe('Промо: Instagram')
    expect(stateText('g-sets-2109')).toBe('готово')
    expect(stateText('g-life-coffee')).toBe('готово · изменён после снимка')
  })

  it('▲ на плитке коротко, в панели — с тем, что не так', () => {
    expect(stateText('g-1717')).toBe('Мастер не собрался')
    expect(stateText('g-1717', true)).toBe('Мастер не собрался: рассинхрон звука')
    expect(stateText('g-vanished', true)).toBe('Пропал с Я.Диска')
  })

  it('мета-строка: тип, когда пришло, объём', () => {
    const group = groups.get('g-2254')
    expect(group && metaLine(group, now)).toBe('Кастом · сегодня 11:02 · 1,9 ГБ')
  })

  it('у качающегося архива размер — из хода скачивания, нулевой не пишется', () => {
    const archive = groups.get('g-archive')
    expect(archive && metaLine(archive, now)).toBe('сегодня 08:30 · 5,8 ГБ')
    expect(archive && metaLine({ ...archive, size_bytes: 0 }, now)).toBe('сегодня 08:30 · 5,8 ГБ')
    const unknown = archive && {
      ...archive,
      size_bytes: 0,
      state: { ...archive.state, total_bytes: null } as typeof archive.state,
    }
    expect(unknown && metaLine(unknown, now)).toBe('сегодня 08:30')
  })
})
