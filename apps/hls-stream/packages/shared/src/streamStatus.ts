/**
 * The states a catalog entry is written with, under the names the stack has always used for them. The contract
 * holds them because every writer and reader of the catalog shares them.
 *
 * Distinct from the uploader's internal lifecycle, which has states this never names because a reader has no use for
 * them. See `StreamLifecycle` in the uploader.
 */
export {
  CATALOG_STATE_LIVE as STREAM_STATUS_LIVE,
  CATALOG_STATE_SCHEDULED as STREAM_STATUS_SCHEDULED,
  CATALOG_STATE_VOD as STREAM_STATUS_VOD,
  type CatalogState as StreamStatus,
} from '@streaming-monorepo/contracts';
