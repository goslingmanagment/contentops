/**
 * The fake Agency Hub for tests (SPEC §12.0: external systems are fake HTTP servers in test
 * code; the test switches failures on; no live keys in CI). Other packages import it as
 * `@contentops/hub/testing`.
 */
export {
  type FailureKind,
  type FailureRule,
  FakeHttpServer,
  type LoggedRequest,
  MALFORMED_JSON,
} from './fake-http.ts'
export {
  DEFAULT_FAKE_PAGES,
  FAKE_HUB_KEY,
  FakeHub,
  type FakeHubOptions,
  type FakePage,
  type FakePlatform,
  type FakePublication,
  type FakeRow,
  type FakeTargets,
  startFakeHub,
} from './fake-hub.ts'
export { recordingRetry } from './retry.ts'
export { fakePosts, fakeRow } from './rows.ts'
