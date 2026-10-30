import type { UpdateDraftFilesCommand } from '@contentops/contracts/commands/inbox'
import { FILE_ROLE_LABEL } from '@contentops/contracts/domain/files'
import type { InboxGroup } from '@contentops/contracts/domain/inbox'
import type { DownloadAnswer } from '@contentops/contracts/domain/operations'
import { rule } from '../domain-error'
import type { ModelWorld } from '../fixtures/world-types'
import { registerSample } from '../sample-files'
import type { MockState } from '../state'

/** Files of a draft: roles, order and «Скачать исходник» (DESIGN §4.8, панель группы). */

/** Photos are numbered in their order: «фото 1», «фото 2»; other roles keep their word. */
export function relabel(group: InboxGroup) {
  let photo = 0
  group.files = group.files.map((file) => {
    if (file.role !== 'photo') {
      return { ...file, position: null, role_label: FILE_ROLE_LABEL[file.role] }
    }
    photo += 1
    return { ...file, position: photo, role_label: `фото ${photo}` }
  })
}

export function applyFileChanges(group: InboxGroup, command: UpdateDraftFilesCommand) {
  if (command.order) {
    const byKey = new Map(group.files.map((file) => [file.key, file]))
    const ordered = command.order.flatMap((key) => {
      const file = byKey.get(key)
      return file ? [file] : []
    })
    if (ordered.length !== group.files.length) {
      throw rule('invalid_request', 'В порядке должны быть все файлы группы')
    }
    group.files = ordered
  }
  for (const change of command.roles ?? []) {
    const file = group.files.find((candidate) => candidate.key === change.key)
    if (!file) throw rule('invalid_request', 'Такого файла в группе нет')
    file.role = change.role
  }
  relabel(group)
}

/** One file is ready at once; several go into a ZIP that is built in the tray. */
export function startDraftDownload(
  state: MockState,
  model: ModelWorld,
  group: InboxGroup,
): DownloadAnswer {
  const [single, ...rest] = group.files
  if (!single) throw rule('accept_blocked', 'Файлы группы ещё не скачались с Я.Диска')
  const base = `/api/v1/${model.model.code}/inbox/groups/${group.id}/source`
  const source = `Приехало · «${group.title}» · Я.Диск: ${group.source_path}`
  if (rest.length === 0) {
    const url = `${base}?name=${encodeURIComponent(single.file_name)}`
    registerSample(state, url, {
      file_name: single.file_name,
      kind: 'Исходник — как пришёл, без пересжатия',
      size_bytes: single.size_bytes,
      source,
      meta_stripped: false,
      members: [],
    })
    return {
      kind: 'ready',
      download_url: url,
      file_name: single.file_name,
      size_bytes: single.size_bytes,
    }
  }
  const fileName = `${group.title.replaceAll('/', '-')}.zip`
  registerSample(state, `${base}?name=${encodeURIComponent(fileName)}`, {
    file_name: fileName,
    kind: 'Архив исходников — как пришли, без пересжатия',
    size_bytes: group.size_bytes,
    source,
    meta_stripped: false,
    members: group.files.map((file) => file.file_name),
  })
  const operation = state.operations.start({
    model: model.model.code,
    kind: 'source_zip',
    label: `Исходники собираются · ${group.title}`,
    done_label: `Исходники готовы · ${group.title}`,
    result: {
      download_url: `${base}?name=${encodeURIComponent(fileName)}`,
      file_name: fileName,
      size_bytes: group.size_bytes,
    },
  })
  return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
}
