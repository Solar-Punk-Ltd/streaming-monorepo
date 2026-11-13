import type {
  ArchiveActionRequest,
  ArchiveBuyChoice,
  ArchiveBuyTerms,
  ArchiveJobSummary,
  ArchiveStartRequest,
  StreamArchiveSummary,
} from '@streaming-monorepo/web2-admin-common';

/**
 * The seams of the console's archive parts, so each is built and tested against the others' shapes alone:
 * `docs/architecture/web2-admin.md`, "Archiving a recording". The API's own shapes are in
 * `@streaming-monorepo/web2-admin-common` (`archive.ts`).
 *
 * - The buy dialog, `BuyStampDialog.tsx`, is one component for two places: the Stamps tab's "Buy archive stamp" and
 *   the archive panel's "Buy a new archive stamp". It takes {@link BuyStampDialogProps} and sends nothing itself: the
 *   caller's `onConfirm` does. On the Stamps tab that is a POST to `ARCHIVE_STAMP_PURCHASES_PATH`, in the archive
 *   panel a POST to `ARCHIVE_CONFIRM_PURCHASE_PATH`, each with the choice.
 * - The badge, `ArchiveBadge.tsx`, takes {@link ArchiveBadgeProps}. The stream list, the Archive page and the stream
 *   page show it.
 * - The provider, `ArchiveProvider.tsx`, offers {@link ArchiveContextValue} through `useArchive()` to every page, as
 *   `ExportProvider` offers the export. The archive panel, the widget, the stream page's archive card and the download
 *   panel's "Archive this quality" are built on it. The Archive page and the stream list open the panel through it.
 *
 * The mock API, `scripts/mock-api.mjs`, seeds each part under a variable of its own, so the two that seed do not
 * meet: {@link MOCK_ARCHIVE_SEEDS} and {@link MOCK_ARCHIVE_STAMPS_SEEDS}.
 */

/**
 * The one buy dialog. It prices with `archiveBuyQuote` and refuses with `archiveBuyProblem`, both of the common
 * package, so it shows what the API checks. Each depth shows what it holds and what it costs for the days chosen,
 * which are `terms.defaultDays` at first and `terms.minimumDays` at least.
 */
export interface BuyStampDialogProps {
  open: boolean;
  /** The price, the paying wallet and the bounds, from `ArchiveStampsResponse.buy` or the job's `proposal.terms`. */
  terms: ArchiveBuyTerms;
  /**
   * A recording's measured chunk count, as the archive panel gives it. The dialog then starts on the smallest depth
   * that holds it with the margin, offers that depth and every deeper one, and no shallower. Left out, as on the
   * Stamps tab, every depth of the capacity table is offered, starting on the shallowest.
   */
  chunkCount?: number;
  /** True while the choice is being sent, when the dialog takes no second confirm. */
  busy: boolean;
  /**
   * The API's sentence when it refused the choice, shown in the dialog, or null: `ARCHIVE_PURCHASES_NOT_OFFERED` for
   * a manager that offers no purchases, the new cost when the price moved, what the wallet lacks.
   */
  refusal: string | null;
  /** The user confirmed this choice, after the confirm step that names its cost. The caller sends it. */
  onConfirm: (choice: ArchiveBuyChoice) => void;
  onClose: () => void;
}

/** The stream list's badge. It shows `ARCHIVE_BADGE_TEXT` for the state, and nothing for a stream with no archive. */
export interface ArchiveBadgeProps {
  archive: StreamArchiveSummary | undefined;
}

/** Whether the archive panel is open, on which stream, and with which qualities ticked. */
export interface ArchivePanelState {
  open: boolean;
  /** The stream the panel is on, or null when it shows the current archive, as the widget opens it. */
  streamId: string | null;
  /** The qualities ticked when it opened, as the download panel does with the quality it exported. */
  preselect: readonly string[];
}

/** What `useArchive()` answers on every page, shaped as `ExportContextValue`. */
export interface ArchiveContextValue {
  /** The archive on the server, which every signed-in user sees, polled as the export is, or null. */
  current: ArchiveJobSummary | null;
  panel: ArchivePanelState;
  /** Opens the archive panel for a stream, or on the current archive with null. */
  openPanel: (streamId: string | null, preselect?: readonly string[]) => void;
  closePanel: () => void;
  /** Reads the archive again now, for a page that changed something it shows. */
  refresh: () => Promise<void>;
  /** Starts an archive. Rejects with the API's sentence when it is refused. */
  start: (streamId: string, request: ArchiveStartRequest) => Promise<void>;
  /** Acts on the current archive. Rejects with the API's sentence when it is refused. */
  act: (request: ArchiveActionRequest) => Promise<void>;
  /** Confirms the stamp the current archive waits to buy. Rejects with the API's sentence when it is refused. */
  confirmPurchase: (choice: ArchiveBuyChoice) => Promise<void>;
}

/**
 * What `MOCK_ARCHIVE` takes in the mock API: which archive job a start seeds, of the first seeded recording, as
 * `MOCK_EXPORT` decides the export. The archive panel, the widget and the stream page's card are tried with these, and
 * the seeded recordings carry per-stream archive states whichever is set: one archived, one reduced, one partial, one
 * outdated, one expired and one with none.
 *
 * - `off`, the default: no job.
 * - `measuring`, `copying`, `verifying`: a job another user started, moving.
 * - `awaiting_purchase`: one the seeded user started, waiting on the buy dialog with its proposal.
 * - `buying`: one whose purchase is under way, which turns usable and copies.
 * - `paused_user`, `paused_unreadable`, `paused_batch`, `paused_funds`, `paused_node`: one the seeded user started,
 *   paused for that reason, so the panel comes to front for every reason but the first.
 * - `waiting`: one whose stream went live again.
 * - `done`, `done_reduced`: a finished one, the second with parity chunks left out.
 */
export const MOCK_ARCHIVE_SEEDS = [
  'off',
  'measuring',
  'awaiting_purchase',
  'buying',
  'copying',
  'verifying',
  'paused_user',
  'paused_unreadable',
  'paused_batch',
  'paused_funds',
  'paused_node',
  'waiting',
  'done',
  'done_reduced',
] as const;
export type MockArchiveSeed = (typeof MOCK_ARCHIVE_SEEDS)[number];

/**
 * What `MOCK_ARCHIVE_STAMPS` takes in the mock API: the archive stamps and purchases of the funding mock, which the
 * Stamps tab's group, the buy dialog and the Archive page are tried with. The catalogue node's chequebook is part of
 * the funding mock's own nodes, under `MOCK_FUNDING` as every other.
 *
 * - `some`, the default: three stamps, one with room, one nearly full and one that expires soon.
 * - `none`: no archive stamp, the group's empty state.
 * - `buying`: `some`, and a purchase under way that turns usable.
 * - `left`: `some`, and a stamp left on a node that is the catalogue node no longer, which is topped up alone.
 * - `unoffered`: the purchase route answers as a manager that offers no purchases does.
 */
export const MOCK_ARCHIVE_STAMPS_SEEDS = ['some', 'none', 'buying', 'left', 'unoffered'] as const;
export type MockArchiveStampsSeed = (typeof MOCK_ARCHIVE_STAMPS_SEEDS)[number];
