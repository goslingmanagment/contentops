import { mskInstant } from '@contentops/contracts/clock'
import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { ItemFile } from '@contentops/contracts/domain/files'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { itemTypeOf } from '@contentops/contracts/domain/item-type'
import type { MarkupField } from '@contentops/contracts/domain/markup'
import type { ProvenanceLink } from '@contentops/contracts/domain/provenance'
import { synthesizeFiles, synthesizeFrames, synthesizeMarkup } from './item-files'
import { PERSON } from './people'
import type { ItemRecord } from './world-types'

/** Files, markup, origin and old names of the objects the §9.3 table describes in full. */

type RecordPatch = (record: ItemRecord) => void

function link(
  id: string,
  relation: ProvenanceLink['relation'],
  direction: ProvenanceLink['direction'],
  itemId: ItemId,
  title: string,
  extra: string | null = null,
  confirmed = true,
): ProvenanceLink {
  return {
    id,
    relation,
    direction,
    item_id: itemId,
    item_type: itemTypeOf(itemId),
    item_title: title,
    extra,
    confirmed,
  }
}

function confirmedMarkup(
  entry: CatalogEntry,
  on: string,
  extra: Partial<Record<'description' | 'timeline', MarkupField['field']>> = {},
): MarkupField[] {
  const at = mskInstant(on, '18:20')
  return synthesizeMarkup({ ...entry, markup: 'confirmed' }).map((field) => {
    const override = extra[field.field.key as 'description' | 'timeline']
    const filled = override ?? field.field
    const empty =
      (filled.key === 'description' && filled.value === '') ||
      (filled.key === 'timeline' && filled.value.length === 0)
    return {
      ...field,
      field: filled,
      status: empty ? 'empty' : 'confirmed',
      confirmed_by: empty ? null : 'Диана',
      confirmed_at: empty ? null : at,
      source_hint: null,
    }
  })
}

function withMasterVersions(files: ItemFile[], versions: ItemFile['versions']): ItemFile[] {
  return files.map((file) =>
    file.role === 'master' ? { ...file, versions, current_version: versions.length } : file,
  )
}

const PATCHES: Record<ItemId, RecordPatch> = {
  'PPV-073': (record) => {
    const entry = record.entry
    record.description =
      'День рождения: торт со свечами, кружевное бельё, медленный тизинг у зеркала и в спальне.'
    record.files = withMasterVersions(synthesizeFiles(entry), [
      { no: 1, on: '2026-08-07', reason: null, duration_s: 812 },
      { no: 2, on: '2026-08-12', reason: 'перемонтаж', duration_s: 804 },
    ])
    record.frames = synthesizeFrames(entry)
    record.markup = confirmedMarkup(entry, '2026-08-12', {
      description: { key: 'description', value: record.description },
      timeline: {
        key: 'timeline',
        value: [
          { start_s: 0, label: 'торт и свечи' },
          { start_s: 145, label: 'бельё' },
          { start_s: 410, label: 'у зеркала' },
          { start_s: 620, label: 'в спальне' },
        ],
      },
    })
    record.provenance = [
      link('pv-073-raw', 'made_from', 'out', 'RAW-0034', 'Съёмка 6 августа'),
      link('pv-073-prm14', 'made_from', 'in', 'PRM-014', 'Reddit, август', 'Reddit'),
      link('pv-073-prm12', 'made_from', 'in', 'PRM-012', 'Twitter, июнь', 'Twitter'),
    ]
    record.ydisk_path = '1. PPV / Bundles / [PPV-073]_birthday_07.08.26'
    record.old_names = [
      { name: '[PPV-073]_birthday_07.08.26', kind: 'folder', with_fan_name: false },
      { name: '07.08 Birthday gift PPV', kind: 'album', with_fan_name: false },
      { name: 'used2_31.07', kind: 'file', with_fan_name: false },
    ]
    record.receipts = [
      {
        id: 'rc-073-1',
        file_name:
          'PPV-073_den-rozhdeniya-tort-kruzhevo_master__lora-1_2026-08-07_2000__13m24s.mp4',
        by: { type: 'person', id: PERSON.diana, name: 'Диана', gender: 'f' },
        at: mskInstant('2026-08-07', '19:40'),
        meta_stripped: true,
        plan_row_id: null,
      },
    ]
  },
  'PPV-076': (record) => {
    const files = synthesizeFiles(record.entry).map((file) =>
      file.role === 'teaser'
        ? { ...file, state: { kind: 'processing' as const, label: 'проверяется', progress: null } }
        : file,
    )
    record.files = files
    record.frames = synthesizeFrames(record.entry)
    record.provenance = [
      link('pv-076-cus', 'ppv_from_custom', 'out', 'CUS-181', 'Нейлон и каблуки'),
    ]
    record.ydisk_path = '1. PPV / Bundles / [PPV-076]_nylon_heels_21.09.26'
  },
  'CUS-181': (record) => {
    record.provenance = [
      link('pv-076-cus-in', 'ppv_from_custom', 'in', 'PPV-076', 'Нейлон и каблуки'),
    ]
    record.markup = confirmedMarkup(record.entry, '2026-09-15', {
      timeline: {
        key: 'timeline',
        value: [
          { start_s: 0, label: 'нейлон, тизинг' },
          { start_s: 250, label: 'анал' },
          { start_s: 410, label: 'каблуки крупно' },
        ],
      },
    })
  },
  'CUS-195': (record) => {
    record.description = 'Танец живота в комнате, под музыку, без реквизита.'
  },
  'FYP-0801': (record) => {
    const files = synthesizeFiles(record.entry)
    const montage = files.find((file) => file.role === 'montage')
    if (!montage) return
    record.files = [
      ...files,
      {
        ...montage,
        key: 'source',
        role: 'source',
        label: 'исходник',
        file_name: 'IMG_7117.MOV',
        source: { item_id: 'RAW-0034', file_key: 'raw07' },
      },
    ]
    record.provenance = [link('pv-0801-raw', 'made_from', 'out', 'RAW-0034', 'Съёмка 6 августа')]
  },
  'RAW-0034': (record) => {
    record.provenance = [
      link('pv-073-raw-in', 'made_from', 'in', 'PPV-073', 'День рождения, торт, кружево'),
      link('pv-0801-raw-in', 'made_from', 'in', 'FYP-0801', 'Зеркало, чёрное боди'),
    ]
  },
  'SXT-012': (record) => {
    record.old_names = [
      { name: '🖤S12 - Чулки, каблуки', kind: 'album', with_fan_name: false },
      { name: 'sexting_012_stockings_heels_31.05.26', kind: 'folder', with_fan_name: false },
    ]
    record.ydisk_path = '5. Sextings / sexting_012_stockings_heels_31.05.26'
  },
  'PPV-067': (record) => {
    record.old_names = [
      { name: '[PPV-066]_shimmer_Teasing_5min_10.04.2026', kind: 'folder', with_fan_name: false },
      { name: 'PPV-066', kind: 'number', with_fan_name: false },
    ]
  },
  'PPV-061': (record) => {
    record.old_names = [
      { name: '[PPV-061]_washing_machine_10min_X.X.X', kind: 'folder', with_fan_name: false },
      { name: 'used2_31.07', kind: 'file', with_fan_name: false },
    ]
  },
  'PPV-081': (record) => {
    record.old_names = [{ name: '[PPV-032]_halloween', kind: 'folder', with_fan_name: false }]
  },
  'PPV-082': (record) => {
    record.old_names = [{ name: '[PPV-032]_brown_set', kind: 'folder', with_fan_name: false }]
  },
  'PPV-032': (record) => {
    record.old_names = [{ name: '[PPV-032]_milk', kind: 'folder', with_fan_name: false }]
  },
}

/** Applies the detailed overrides to the records of Лора. */
export function applyDetailedRecords(records: Map<ItemId, ItemRecord>) {
  for (const [id, patch] of Object.entries(PATCHES)) {
    const record = records.get(id)
    if (record) patch(record)
  }
}
