/**
 * Имя человека в творительном падеже для «Удалён 12.09 Дианой»: русские имена людей
 * агентства склоняются правильно (Диана, Никита, Дмитрий), чужое имя остаётся как есть.
 */
export function instrumentalName(name: string): string {
  if (/[ая]$/.test(name)) {
    return `${name.slice(0, -1)}${name.endsWith('я') ? 'ей' : 'ой'}`
  }
  if (name.endsWith('й')) {
    return `${name.slice(0, -1)}ем`
  }
  return name
}
