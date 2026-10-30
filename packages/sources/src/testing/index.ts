/**
 * Fake cloud servers for tests (SPEC §12.0: external systems are fake HTTP servers in test
 * code; the test switches failures on; no live keys in CI). Other packages import them as
 * `@contentops/sources/testing`.
 */
export { FakeDropbox, type FakeDropboxOptions, startFakeDropbox } from './fake-dropbox.ts'
export {
  type FailureKind,
  type FailureRule,
  FakeHttpServer,
  type LoggedRequest,
  MALFORMED_JSON,
} from './fake-server.ts'
export {
  type Change,
  type FakeNode,
  FakeTree,
  type FileOptions,
  fakeBytes,
  md5Hex,
  sha256Hex,
} from './fake-tree.ts'
export {
  FakeYandexDisk,
  type FakeYandexDiskOptions,
  startFakeYandexDisk,
} from './fake-yandex-disk.ts'
export { recordingRetry } from './retry.ts'
