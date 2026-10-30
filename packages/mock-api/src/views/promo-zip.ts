import type { ContractorFormat } from '@contentops/contracts/domain/promo'
import { type FileHandle, handleOf } from '@contentops/contracts/download-files'
import {
  ordinalToken,
  PROMO_MANIFEST_NAME,
  promoMemberName,
} from '@contentops/contracts/download-name'
import { hashString } from '@contentops/contracts/hash'
import { synthesizeFiles } from '../fixtures/item-files'
import type { HandoffRecord, ModelWorld } from '../fixtures/world-types'

/**
 * Состав ZIP промо-передачи (naming §6): файлы `PRM-013_001_RAW-0213-raw03.mp4` по
 * порядку подборки и `manifest.csv` передачи — номер, порядок, источник, роль,
 * версия, SHA-256 мастера, профиль, имя и размер.
 */

interface ZipMember {
  name: string
  source: string
  handle: FileHandle
  version: number
  size_bytes: number
}

/** Условный SHA-256 мастера для образца: 64 шестнадцатеричных знака из ключа. */
function sampleSha256(key: string): string {
  return Array.from({ length: 8 }, (_, index) =>
    hashString(`${key}#${index}`).toString(16).padStart(8, '0'),
  ).join('')
}

function memberOf(
  model: ModelWorld,
  handoff: HandoffRecord,
  key: string,
  index: number,
): ZipMember {
  const [itemId = '', fileKey = ''] = key.split('/')
  const record = model.items.get(itemId)
  const files = record ? (record.files ?? synthesizeFiles(record.entry)) : []
  const file = files.find((candidate) => candidate.key === fileKey)
  const member = model.collections
    .get(handoff.collection_id)
    ?.members.find((candidate) => `${candidate.item_id}/${candidate.file_key}` === key)
  const handle: FileHandle =
    record && file ? handleOf(record.entry, files, file) : { role: 'clip', ordinal: null }
  const video = (member?.media ?? file?.media ?? 'video') === 'video'
  return {
    name: promoMemberName(
      handoff.collection_id,
      index + 1,
      handoff.members.length,
      { id: itemId, ...handle },
      video ? 'mp4' : 'jpg',
    ),
    source: itemId,
    handle,
    version: file?.current_version ?? 1,
    size_bytes: member?.size_bytes ?? file?.size_bytes ?? 0,
  }
}

export function promoZipMembers(model: ModelWorld, handoff: HandoffRecord): ZipMember[] {
  return handoff.members.map((key, index) => memberOf(model, handoff, key, index))
}

/** Файлы ZIP по порядку и манифест последним. */
export function promoZipListing(members: readonly ZipMember[]): string[] {
  return [...members.map((member) => member.name), PROMO_MANIFEST_NAME]
}

/** Начало `manifest.csv`: заголовок и первые строки. */
export function promoManifestHead(
  handoff: HandoffRecord,
  members: readonly ZipMember[],
  format: ContractorFormat | null,
  rows = 3,
): string[] {
  const profile = format ?? 'compact'
  const header = 'prm,order,file_name,source_id,role,version,master_sha256,profile,size_bytes'
  const lines = members
    .slice(0, rows)
    .map((member, index) =>
      [
        handoff.collection_id,
        index + 1,
        member.name,
        member.source,
        `${member.handle.role}${member.handle.ordinal ? ordinalToken(member.handle.ordinal) : ''}`,
        member.version,
        sampleSha256(`${member.source}/${member.name}`),
        `${profile}@1`,
        member.size_bytes,
      ].join(','),
    )
  return [header, ...lines]
}
