import { EXPORT_NAME_PATTERN } from '@contentops/contracts/download-name'

/**
 * The name of a ContentOps download as a clue (SPEC §7 «Точное по Hub», naming §5–6): the name
 * of the platform file (`filename` of an attachment, `customFilename` in the vault) is read by
 * the download grammar into the object, the file and its version. Both forms of the name match
 * — with and without the suffix of page, date and duration — and the extension does not matter.
 */

export interface NameCore {
  /** `PPV-073`. */
  id: string
  /** `master`, `pic03`, `pic03_u2_v2`: role, ordinal, unique version and version. */
  file: string
  /** One key for both forms of the name: `PPV-073|pic03|u0|v1`. */
  key: string
}

const KNOWN_EXT = /\.[a-z0-9]{2,4}$/i

/** The core of a download name; `null` — not a name ContentOps gave. */
export function nameCore(filename: string | null | undefined): NameCore | null {
  if (!filename) return null
  const trimmed = filename.trim().normalize('NFC')
  // The platform may give another extension or none: the grammar wants one.
  const withExt = KNOWN_EXT.test(trimmed) ? trimmed.toLowerCase() : `${trimmed.toLowerCase()}.x0`
  const upperId = withExt.replace(/^([a-z]+)-/, (prefix) => prefix.toUpperCase())
  const match = EXPORT_NAME_PATTERN.exec(upperId)
  if (!match?.groups) return null
  const { id, role, ord, uniq, version } = match.groups
  if (!id || !role) return null
  const ordinal = ord ? Number(ord) : 0
  const file = `${role}${ord ?? ''}${uniq ? `_u${uniq}` : ''}${version ? `_v${version}` : ''}`
  return {
    id,
    file,
    key: `${id}|${role}${ordinal}|u${uniq ?? 0}|v${version ?? 1}`,
  }
}

/** Width and height as a pair without rotation. */
export function sameSize(
  left: { width: number | null; height: number | null },
  right: { width: number | null; height: number | null },
): boolean | null {
  if (!left.width || !left.height || !right.width || !right.height) return null
  return (
    (left.width === right.width && left.height === right.height) ||
    (left.width === right.height && left.height === right.width)
  )
}
