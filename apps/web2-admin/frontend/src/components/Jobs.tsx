import { EXPORT_ACTIVE_STATES, exportFilePath } from '@streaming-monorepo/web2-admin-common';
import ArchiveIcon from '@mui/icons-material/Archive';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { Badge, Box, IconButton, LinearProgress, Typography, useMediaQuery, type Theme } from '@mui/material';
import type { MouseEvent, ReactNode } from 'react';

import { errorMessage } from '../errors';
import { ArchiveProvider, useArchive } from './archive/ArchiveProvider';
import {
  archiveMoving,
  archiveNeedsDecision,
  archivePercent,
  archiveQualities,
  archiveWidgetLine,
} from './archive/archiveJobText';
import { ExportProvider, useExport } from './export/ExportProvider';
import { needsDecision, outdatedLine, percentRead, widgetLine } from './export/exportText';
import { useSnackbar } from './Snackbar';

/** The export and the archive on the server, which every page and every signed-in user shares. */
export function JobProviders({ children }: { children: ReactNode }) {
  return (
    <ExportProvider>
      <ArchiveProvider>{children}</ArchiveProvider>
    </ExportProvider>
  );
}

/**
 * The jobs on the server as indicators in the header of every page, for every signed-in user: the export's and the
 * archive's, side by side. The one that holds the place a job has comes first, so a running archive shows before a
 * kept export file, and a running export before an archive a user paused. Below `sm` each is its icon, with its close
 * button once the job is done.
 */
export function JobIndicators() {
  const { current: archive } = useArchive();
  const narrow = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'), { noSsr: true });
  const indicators =
    archive !== null && archive.holdsPlace
      ? [<ArchiveIndicator key="archive" narrow={narrow} />, <ExportIndicator key="export" narrow={narrow} />]
      : [<ExportIndicator key="export" narrow={narrow} />, <ArchiveIndicator key="archive" narrow={narrow} />];
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: narrow ? 0.5 : 1,
        minWidth: 0,
        flexShrink: narrow ? 0 : 1,
        ml: narrow ? 1 : 2,
        mr: narrow ? 0.5 : 2,
        // With no job on the server it takes no room in the header.
        '&:empty': { display: 'none' },
      }}
    >
      {indicators}
    </Box>
  );
}

/** The export's indicator: its stream and quality, how far it read, and once done, Save file and close. */
function ExportIndicator({ narrow }: { narrow: boolean }) {
  const { current, openPanel, act } = useExport();
  const snackbar = useSnackbar();
  if (!current) return null;
  const active = EXPORT_ACTIVE_STATES.includes(current.state);
  if (!active && current.dismissed) return null;

  return (
    <JobIndicator
      job="export"
      Icon={DownloadIcon}
      tone={needsDecision(current) ? 'warning' : active ? 'primary' : 'success'}
      name={`${current.streamTitle} · ${current.quality}`}
      line={widgetLine(current)}
      lineWarning={outdatedLine(current) !== null}
      progress={active ? percentRead(current) : undefined}
      narrow={narrow}
      onOpen={() => openPanel(null)}
      onClose={
        current.state === 'done'
          ? () => {
              act('dismiss').catch((error: unknown) => snackbar.error(errorMessage(error, 'It could not be closed.')));
            }
          : undefined
      }
      save={
        current.state === 'done' ? (
          <IconButton
            size="small"
            component="a"
            href={exportFilePath(current.id)}
            download={current.fileName ?? true}
            aria-label="Save file"
            onClick={(event: MouseEvent) => event.stopPropagation()}
          >
            <SaveAltIcon fontSize="small" />
          </IconButton>
        ) : undefined
      }
    />
  );
}

/** The archive's indicator: its stream and qualities, where it stands, and once done, close. */
function ArchiveIndicator({ narrow }: { narrow: boolean }) {
  const { current, openPanel, act } = useArchive();
  const snackbar = useSnackbar();
  if (!current) return null;
  if (current.state === 'done' && current.dismissed) return null;
  const done = current.state === 'done';

  return (
    <JobIndicator
      job="archive"
      Icon={ArchiveIcon}
      tone={archiveNeedsDecision(current) ? 'warning' : done ? 'success' : 'primary'}
      name={`${current.streamTitle} · ${archiveQualities(current)}`}
      line={archiveWidgetLine(current)}
      progress={archiveMoving(current) ? archivePercent(current) : undefined}
      narrow={narrow}
      onOpen={() => openPanel(null)}
      onClose={
        done
          ? () => {
              act({ action: 'dismiss' }).catch((error: unknown) =>
                snackbar.error(errorMessage(error, 'It could not be closed.')),
              );
            }
          : undefined
      }
    />
  );
}

/** Orange when the job needs a decision, green once it is done, the look's accent otherwise. */
type Tone = 'primary' | 'warning' | 'success';

interface JobIndicatorProps {
  /** The name assistive technology gives the indicator, and the job its open button names. */
  job: 'archive' | 'export';
  Icon: typeof ArchiveIcon;
  tone: Tone;
  /** The stream's title and the qualities: `Opening keynote · 720p`. */
  name: string;
  /** Where the job stands, in a few words. */
  line: string;
  /** Shows the line as a warning while the job's tone does not: a kept export file that is out of date. */
  lineWarning?: boolean;
  /** The bar while the job moves: how far, 0 to 100, null while that is unknown; undefined for no bar. */
  progress: number | null | undefined;
  narrow: boolean;
  onOpen: () => void;
  /** Closes a finished job for this user, from a close button on either width; undefined while it is unfinished. */
  onClose?: () => void;
  /** Save file, for a finished export. Only the wide indicator shows it: on a narrow one the panel offers it. */
  save?: ReactNode;
}

/**
 * One job in the header. Clicking it opens the job's panel, and so does its icon, a button a keyboard reaches. Below
 * `sm` it is the icon, with a dot when the job needs a decision or is done and a label that gives the stream and where
 * it stands, and a finished job keeps its close button beside it.
 */
function JobIndicator({
  job,
  Icon,
  tone,
  name,
  line,
  lineWarning = false,
  progress,
  narrow,
  onOpen,
  onClose,
  save,
}: JobIndicatorProps) {
  const close = onClose ? (
    // Narrow, it sits close to its own icon, so it reads as that job's and not the next one's.
    <IconButton
      size="small"
      aria-label={`close the ${job}`}
      onClick={stopThen(onClose)}
      sx={narrow ? { ml: -0.5 } : undefined}
    >
      <CloseIcon fontSize="small" />
    </IconButton>
  ) : null;

  if (narrow) {
    return (
      <Box role="status" aria-label={job} sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <IconButton aria-label={`${name}: ${line}`} onClick={onOpen} sx={{ color: `${tone}.main` }}>
          <Badge variant="dot" color={tone} invisible={tone === 'primary'}>
            <Icon />
          </Badge>
        </IconButton>
        {close}
      </Box>
    );
  }

  return (
    <Box
      role="status"
      aria-label={job}
      onClick={onOpen}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        flex: '0 1 300px',
        minWidth: 0,
        py: 0.5,
        pl: 0.25,
        pr: 0.75,
        border: 1,
        borderLeft: 3,
        borderColor: 'divider',
        borderLeftColor: `${tone}.main`,
        borderRadius: 1,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <IconButton size="small" aria-label={`open the ${job}`} onClick={stopThen(onOpen)} sx={{ color: `${tone}.main` }}>
        <Icon fontSize="small" />
      </IconButton>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" noWrap title={name} sx={{ fontWeight: 500, lineHeight: 1.3 }}>
          {name}
        </Typography>
        <Typography
          variant="caption"
          component="div"
          noWrap
          title={line}
          sx={{ lineHeight: 1.3, color: tone === 'warning' || lineWarning ? 'warning.main' : 'text.secondary' }}
        >
          {line}
        </Typography>
        {progress === undefined ? null : (
          // The line above says how far in words, so the bar is for the eye alone.
          <LinearProgress
            aria-hidden
            variant={progress === null ? 'indeterminate' : 'determinate'}
            value={progress ?? 0}
            color={tone}
            sx={{ mt: 0.5, height: 3, borderRadius: 1 }}
          />
        )}
      </Box>
      {save}
      {close}
    </Box>
  );
}

/** A click on a button inside an indicator, which the indicator around it must not take as its own. */
function stopThen(then: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    then();
  };
}
