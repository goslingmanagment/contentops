import type { ItemType } from '../domain/item-type'
import type { Tag, TagGroup } from '../domain/markup'
import type { Random } from './random'

/**
 * Words of generated titles, taken from real folder slugs of Лора's Я.Диск
 * (`research/07-data-sizing.md` §1.4) and turned into Russian, 2–4 words, no fan names.
 */

const PPV_TITLES = [
  'Стиральная машина',
  'Йога и анал',
  'Ледяные чулки',
  'Белое кружево, тизинг',
  'Леопардовое платье',
  'Медленный стриптиз в чулках',
  'Короткий тизинг, загар',
  'Масло на коже',
  'Домашний халат',
  'Розовые стринги',
  'Чёрное кружево',
  'Сетка и каблуки',
  'Красное платье в отеле',
  'Пена в ванной',
  'Шёлковый халат',
  'Гольфы на кровати',
  'Офисная рубашка',
  'Латекс и каблуки',
]

const SUBJECTS = [
  'Чулки',
  'Кружево',
  'Боди',
  'Нейлон',
  'Колготки',
  'Халат',
  'Сетка',
  'Бельё',
  'Шёлк',
  'Корсет',
  'Каблуки',
  'Рубашка',
  'Платье',
  'Гольфы',
  'Леггинсы',
  'Стринги',
]

const SETTINGS = [
  'у зеркала',
  'в ванной',
  'на кровати',
  'у окна',
  'в душе',
  'на диване',
  'на кухне',
  'в отеле',
  'на столе',
  'в офисе',
  'утром',
  'вечером',
]

const MOODS = ['тизинг', 'стриптиз', 'танец', 'йога', 'примерка']

const CUSTOM_TITLES = [
  'Ноги',
  'Танец живота',
  'Пов от девушки',
  'Уборка',
  'Нейлон',
  'Анал',
  'Йога с пробкой',
  'Колготки',
  'Грудь',
  'После душа',
  'Тизинг с тенями',
  'В маске',
  'Примерка белья',
  'Грудь и попа',
  'Вся в красном',
  'В чёрном спорт',
  'Вибратор',
  'Босс',
  'Ноги в нейлоне',
  'Чёрное платье',
  'Фото в рубашке',
  'Масло',
  'Офис',
  'Чулки и пояс',
]

const SET_TITLES = [
  'Отель, попа',
  'Чёрное боди и чулки',
  'Цепи',
  'Офисная зайка',
  'На столе',
  'Рисую',
  'Белый лонгслив',
  'День рождения',
  'Отель, кровать, бельё',
  'Утро в постели',
  'Красный корсет',
  'Кухня, фартук',
]

const LIFE_TITLES = [
  'Дубай, отель',
  'Дубай, ночь',
  'Спортзал',
  'Гатчинский дворец',
  'Новогоднее',
  'Кот',
  'День рождения',
  'Прогулка в парке',
  'Кофе утром',
  'Пляж',
  'Кафе с подругой',
  'Шопинг',
  'Море',
  'Дача',
  'Цветы',
  'Салон красоты',
]

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

function combined(random: Random): string {
  const subject = random.pick(SUBJECTS)
  return random.chance(0.7)
    ? `${subject} ${random.pick(SETTINGS)}`
    : `${subject}, ${random.pick(MOODS)}`
}

/** Title of a generated object; raw footage is named by the shooting day. */
export function generatedTitle(type: ItemType, random: Random, shotOn: string): string {
  switch (type) {
    case 'ppv':
      return random.chance(0.4) ? random.pick(PPV_TITLES) : combined(random)
    case 'fyp':
      return combined(random)
    case 'custom':
      return random.pick(CUSTOM_TITLES)
    case 'set':
      return random.chance(0.5) ? random.pick(SET_TITLES) : combined(random)
    case 'sexting':
      return combined(random)
    case 'life':
      return random.pick(LIFE_TITLES)
    case 'raw':
      return `Съёмка ${Number(shotOn.slice(8, 10))} ${MONTHS[Number(shotOn.slice(5, 7)) - 1] ?? ''}`
    case 'promo':
      return `Подборка ${random.pick(SUBJECTS).toLowerCase()}`
  }
}

type DictionaryTag = Omit<Tag, 'uses' | 'version'>

/** Tags generated objects draw from; a couple of free tags have no group yet. */
const GENERATED_TAGS: readonly DictionaryTag[] = [
  { key: 'teasing', ru: 'тизинг', group: 'action' },
  { key: 'striptease', ru: 'стриптиз', group: 'action' },
  { key: 'dance', ru: 'танец', group: 'action' },
  { key: 'yoga', ru: 'йога', group: 'action' },
  { key: 'anal', ru: 'анал', group: 'action' },
  { key: 'blowjob', ru: 'минет', group: 'action' },
  { key: 'toy', ru: 'игрушка', group: 'action' },
  { key: 'try_on', ru: 'примерка', group: 'action' },
  { key: 'shower', ru: 'душ', group: 'action' },
  { key: 'stockings', ru: 'чулки', group: 'attribute' },
  { key: 'lace', ru: 'кружево', group: 'attribute' },
  { key: 'heels', ru: 'каблуки', group: 'attribute' },
  { key: 'bodysuit', ru: 'боди', group: 'attribute' },
  { key: 'thong', ru: 'стринги', group: 'attribute' },
  { key: 'nylon', ru: 'нейлон', group: 'attribute' },
  { key: 'tights', ru: 'колготки', group: 'attribute' },
  { key: 'mirror', ru: 'зеркало', group: 'attribute' },
  { key: 'bedroom', ru: 'спальня', group: 'attribute' },
  { key: 'bathroom', ru: 'ванная', group: 'attribute' },
  { key: 'office', ru: 'офис', group: 'attribute' },
  { key: 'hotel', ru: 'отель', group: 'attribute' },
  { key: 'red', ru: 'красное', group: 'attribute' },
  { key: 'black', ru: 'чёрное', group: 'attribute' },
  { key: 'cake', ru: 'торт', group: 'attribute' },
  { key: 'tender', ru: 'нежное', group: 'mood' },
  { key: 'playful', ru: 'игривое', group: 'mood' },
  { key: 'bold', ru: 'дерзкое', group: 'mood' },
  { key: 'cozy', ru: 'уютное', group: 'mood' },
  { key: 'evening', ru: 'вечернее', group: 'mood' },
  { key: 'pov', ru: null, group: null },
  { key: 'asmr', ru: null, group: null },
]

/** Everyday words of life objects: «Завтрак у окна» — завтрак, окно, утро, домашнее. */
const LIFE_TAGS: readonly DictionaryTag[] = [
  { key: 'breakfast', ru: 'завтрак', group: 'action' },
  { key: 'window', ru: 'окно', group: 'attribute' },
  { key: 'morning', ru: 'утро', group: 'attribute' },
  { key: 'homey', ru: 'домашнее', group: 'mood' },
]

/** Dictionary of three tag groups: what generated objects use and life words. */
export const TAG_DICTIONARY: readonly DictionaryTag[] = [...GENERATED_TAGS, ...LIFE_TAGS]

const TAGS_BY_GROUP = (group: TagGroup) =>
  GENERATED_TAGS.filter((tag) => tag.group === group).map((tag) => tag.key)

/** Two to five tags: an action or two, attributes and sometimes a mood. */
export function generatedTags(random: Random): string[] {
  const tags = new Set<string>()
  tags.add(random.pick(TAGS_BY_GROUP('action')))
  const attributes = random.int(1, 3)
  for (let index = 0; index < attributes; index++) tags.add(random.pick(TAGS_BY_GROUP('attribute')))
  if (random.chance(0.5)) tags.add(random.pick(TAGS_BY_GROUP('mood')))
  return [...tags]
}
