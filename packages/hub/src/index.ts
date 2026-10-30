/**
 * Client of the Agency Hub agent API for ContentOps (SPEC §7, §8.1; PLAN 5, 5б): datasets
 * with the pinned field list checked against `capabilities`, the poll windows, and
 * publication through Hub. A pure client: no database, no clock of its own.
 */
export {
  type CapabilityCheck,
  type CatalogEntry,
  checkCapabilities,
  type DatasetCheck,
  type DatasetProblem,
  describeProblem,
  type GrantedPage,
  type HubCapabilities,
  PUBLISH_CAPABILITIES,
  parseCapabilities,
  READ_CAPABILITY,
} from './capabilities.ts'
export {
  type ChangesPage,
  createHubClient,
  type DatasetPage,
  HUB_PAGE_LIMIT_MAX,
  HUB_WINDOW_FLOOR,
  type HubClient,
  type HubClientOptions,
  parseDatasetPage,
  type ReadDatasetOptions,
  type UploadInput,
} from './client.ts'
export {
  type DatasetFilter,
  type DatasetFilterOp,
  type DatasetRow,
  HUB_DATASETS,
  HUB_FIELD_KINDS,
  type HubDataset,
  type HubFieldKind,
  type HubScalar,
  INCREMENTAL_DATASETS,
  type IncrementalDataset,
  isIncremental,
  PINNED_FIELDS,
  type PinnedFieldList,
  type PinnedFields,
} from './datasets.ts'
export {
  HUB_REFUSAL_CODES,
  HubError,
  type HubErrorKind,
  type HubRefusalCode,
  isHubError,
} from './errors.ts'
export {
  afterPoll,
  DAILY_OVERLAP_MS,
  FULL_REREAD_EVERY_MS,
  type FullReason,
  HOURLY_OVERLAP_MS,
  HUB_POLL_INTERVAL_MS,
  HUB_STATUS_POLL_INTERVAL_MS,
  MAX_GAP_MS,
  type PlanPollInput,
  type PollPlan,
  type PollState,
  planPoll,
  publicationChangesSince,
  STATUS_OVERLAP_MS,
} from './poll.ts'
export {
  type ApproveResult,
  canCancel,
  type DraftChecks,
  type DraftInput,
  draftBody,
  type FanslyAudience,
  HANDED_TO_PLATFORM,
  type HubPublication,
  type MediaKey,
  PUBLICATION_KINDS,
  PUBLICATION_STATUSES,
  type PublicationFile,
  type PublicationFinding,
  type PublicationKind,
  type PublicationRowState,
  type PublicationStatus,
  type PublicationTargets,
  parseMediaKey,
  publicationRowState,
  type UploadResult,
} from './publications.ts'
export { backoffDelay, DEFAULT_RETRY, type RetryPolicy, withRetry } from './retry.ts'
