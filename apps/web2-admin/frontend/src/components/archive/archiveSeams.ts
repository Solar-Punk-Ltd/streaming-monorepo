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
 * - The buy dialog, `ArchiveBuyDialog.tsx`, is one component for two places: the Stamps tab's "Buy archive stamp" and
 *   the archive panel's "Buy a new archive stamp". It takes {@link ArchiveBuyDialogProps}.
 * - The badge, `ArchiveBadge.tsx`, takes {@link ArchiveBadgeProps}. The stream list, the Archive page and the stream
 *   page show it.
 * - The provider, `ArchiveProvider.tsx`, offers {@link ArchiveContextValue} through `useArchive()` to every page, as
 *   `ExportProvider` offers the export. The archive panel, the widget, the stream page's archive card and the download
 *   panel's "Archive this quality" are built on it. The Archive page and the stream list open the panel through it.
 */

/**
 * The one buy dialog. It prices with `archiveBuyQuote` and refuses with `archiveBuyProblem`, both of the common
 * package, so it shows what the API checks. It starts on the quote's `defaultDepth` and lets the user pick any other
 * row, a deeper one than a recording needs among them, and the days. It sends nothing itself.
 */
export interface ArchiveBuyDialogProps {
  open: boolean;
  /** The price, the paying wallet and the bounds, from `ArchiveStampsResponse.buy` or `ArchiveOptionsResponse.buy`. */
  terms: ArchiveBuyTerms;
  /** A recording's measured chunk count, which the rows start from, or null on the Stamps tab, where they are all. */
  chunks: number | null;
  /** True while the choice is being sent, when the dialog takes no second confirm. */
  busy: boolean;
  /** The API's sentence when it refused the choice, shown in the dialog, or null. */
  refusal: string | null;
  /** The user confirmed this choice, after the confirm step that names its cost. */
  onConfirm(choice: ArchiveBuyChoice): void;
  onClose(): void;
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
}
