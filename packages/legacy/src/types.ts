/**
 * Claims of the old names (SPEC §6.3, schema §3.4 `legacy_claims`). A claim is a statement
 * of the old disk, not a fact: the importer turns it into catalog fields, aliases and
 * evidence, or leaves it in the queue with its raw fragment.
 */

/** Item type codes as the database keeps them (schema §3.2 `content_items.type`). */
export type ItemTypeCode = 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW' | 'PRM'

export const ITEM_TYPE_CODES: readonly ItemTypeCode[] = [
  'PPV',
  'SET',
  'SXT',
  'CUS',
  'FYP',
  'LIFE',
  'RAW',
  'PRM',
]

/**
 * `claim_kind` of `legacy_claims`. `title`, `tag` and `origin` were added on 30.10.2026 with
 * this parser: the tail of a custom name is its title (SPEC §6.3), `optional/`, `extra/`,
 * `нюды/` and BG are tags (naming §3, legacy §8), and `IMG_*`, `copy_*`, `lv_0_*`, `PMR*`
 * are evidence of the origin (naming §8).
 */
export type ClaimKind =
  | 'number'
  | 'used'
  | 'posted'
  | 'date'
  | 'role'
  | 'registry_row'
  | 'duration'
  | 'title'
  | 'tag'
  | 'origin'
  | 'unknown'

/** A date of an old name: the year or the day can be missing («неизвестная дата»). */
export interface LegacyDate {
  year: number | null
  month: number | null
  day: number | null
  /** `2026-08-04`, `--07-28` (no year), `2025-04` (a month), `2026` (a year). */
  iso: string
}

/**
 * Where an old label points by the default rule (SPEC §6.3); the КМ confirms every label in
 * the product, until then the claim creates no placement.
 */
export type ProposedAccount =
  | { kind: 'index'; index: number }
  | { kind: 'all' }
  | { kind: 'unknown' }

/** Version of the label → account rule, `payload.account_rule` (schema §9.7). */
export const ACCOUNT_RULE = 'labels@1'

export interface NumberPayload {
  type: ItemTypeCode
  number: number
  /**
   * `bracket` — `[PPV-066]`, `[Set-002]`; `sexting` — `sexting_012`; `registry` — a row of
   * the PPV registry; `fyp_batch` — `FYP_16_30.04.25`; `old_format` — `001 bndl …` of
   * «Старый формат»; `loose` — `ppv73`, `PPV 73` inside a name; `evidence` — a vault album.
   */
  form: 'bracket' | 'sexting' | 'registry' | 'fyp_batch' | 'old_format' | 'loose' | 'evidence'
  /** Only folders `[TYPE-NNN]`, `sexting_NNN` and the registry reserve (SPEC §6.3–6.4). */
  reserves: boolean
}

export interface UsagePayload {
  /** Normalised label the КМ confirms: `used3`, `used`, `used_all`, `posted`, … */
  label: string
  account: ProposedAccount
  account_rule: string
  /** `K` — the post number of the day (`used1_1_28.07`). */
  post_of_day: number | null
  /** `null` — the date is unknown. */
  date: LegacyDate | null
  /** `prefix` — `2used_15.07`; `typo` — `ued3`, `usd2`; `glued` — `used_all_125.08`. */
  notes: string[]
}

export interface DatePayload {
  /** `null` with `unset` — `X.X.X`: «дата не проставлена», not «не выпущен». */
  date: LegacyDate | null
  unset: boolean
  /** End of a range `18.12.25-20.02.26`. */
  until: LegacyDate | null
}

export interface DurationPayload {
  seconds: number
  /** `9min`, `Кастом 10 минут` — minutes only. */
  approximate: boolean
}

export interface RolePayload {
  /** Role proposed by the word; `null` — only an ordinal (`12.mov`, `йога 3`). */
  role: 'master' | 'teaser' | 'ed' | 'raw' | null
  ordinal: number | null
  word: string
}

export interface TitlePayload {
  text: string
  lang: 'ru' | 'en' | 'mixed'
}

export interface TagPayload {
  tag: string
}

export interface OriginPayload {
  origin:
    | 'camera'
    | 'vendor_camera'
    | 'ios_copy'
    | 'capcut'
    | 'messenger'
    | 'screenshot'
    | 'contractor_export'
    | 'recovered'
    | 'export'
    | 'custom'
  /** `кастом_<фан>` of a PPV file. */
  fan?: string
}

export interface RegistryTags {
  actions: string[]
  attributes: string[]
  mood: string[]
}

export interface RegistryRowPayload {
  /** 1-based data row of the export. */
  row: number
  folder: string
  type: 'PPV'
  number: number | null
  /** Words of the folder after the ID, the date and the duration: `anal yoga`. */
  title_en: string | null
  ppv_kind: 'dm' | 'bundle' | null
  tags: RegistryTags
  units: number | null
  comment: string | null
  /** «кастом…» in the comment (legacy §8: «PPV-0NN сделан из кастома — какого?»). */
  from_custom: boolean
  /** Text in parentheses after «кастом», as the table has it. */
  custom_note: string | null
  folder_date: LegacyDate | null
  folder_date_unset: boolean
  duration_seconds: number | null
  /** `posted`, `used` in the comment. */
  posted: boolean
  voice: 'en' | 'ru' | null
}

export interface UnknownPayload {
  reason: string
}

interface ClaimBase<K extends ClaimKind, P> {
  kind: K
  raw_fragment: string
  claim_key: string
  parser_version: string
  payload: P
}

export type LegacyClaim =
  | ClaimBase<'number', NumberPayload>
  | ClaimBase<'used', UsagePayload>
  | ClaimBase<'posted', UsagePayload>
  | ClaimBase<'date', DatePayload>
  | ClaimBase<'duration', DurationPayload>
  | ClaimBase<'role', RolePayload>
  | ClaimBase<'title', TitlePayload>
  | ClaimBase<'tag', TagPayload>
  | ClaimBase<'origin', OriginPayload>
  | ClaimBase<'registry_row', RegistryRowPayload>
  | ClaimBase<'unknown', UnknownPayload>

export type ClaimOf<K extends ClaimKind> = Extract<LegacyClaim, { kind: K }>

/** Section of the old disk a path belongs to (legacy §2, §8). */
export type LegacyArea =
  | 'ppv'
  | 'fyp'
  | 'customs'
  | 'sets'
  | 'sextings'
  | 'life'
  | 'pictures'
  | 'other'
  | 'smm'
  | 'bg'
  | 'old_format'
  | 'root'
  | 'unknown'

export interface PathContext {
  /** Top folder of the path as written (`1. PPV`, `BG`, `Старый формат`); `''` for root files. */
  root: string
  area: LegacyArea
  /** Area inside BG or «Старый формат» (`BG/1. PPV` → `ppv`), else the same as `area`. */
  subArea: LegacyArea
  genre: 'bg' | null
  /** Type the section suggests; the importer decides (legacy §9.2). */
  typeHint: ItemTypeCode | 'LIFE|SET' | null
  rawPurpose: 'fyp' | 'ppv' | 'mass_dm' | null
  /** `1. PPV/Bundles/…` — bundle; a `[PPV-…]` folder in the root of `1. PPV` — DM. */
  ppvKind: 'bundle' | 'dm' | null
  /** `9. SMM/<channel>/…` and `BG/…/twitter/…`. */
  promoChannel: string | null
  vendor: string | null
  /** Path of the archive the entry lies in, `null` outside archives. */
  archive: string | null
  /** The entry itself is an archive (`.zip`, `.rar`, `.7z`). */
  isArchive: boolean
  /** Root archive of another model (`Ari FYP — монтаж … .zip`): parked until she is connected. */
  foreignModel: string | null
  /** `3. Customs/отобранное на PPV/…`: provenance by md5 (legacy §8). */
  selectedForPpv: boolean
}

export interface ParsedLegacyPath {
  /** Root-relative NFC path without `disk:/`. */
  path: string
  name: string
  isDir: boolean
  context: PathContext
  claims: LegacyClaim[]
}

export interface ParseOptions {
  isDir: boolean
  /** Names of other models (`Ari`): a root archive with such a word is parked. */
  foreignModelNames?: readonly string[]
}
