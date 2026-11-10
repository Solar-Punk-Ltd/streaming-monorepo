import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Segment files a joiner copies as one stretch, in order, with each one's length from the playlist. */
export interface JoinRun {
  /** Paths relative to the work folder. */
  files: string[];
  durations: number[];
}

/** Joining what was read into one MP4. */
export interface Joiner {
  /** Null when the joiner can run on this server; otherwise the sentence that says why not. */
  check(): Promise<string | null>;
  /** Joins the runs, in order, into one MP4 at `output`. Nothing is re-encoded. */
  join(runs: JoinRun[], output: string, workDir: string, signal?: AbortSignal): Promise<void>;
  /** The height of the MP4's video, or null for one without video. */
  probeHeight(file: string): Promise<number | null>;
}

const FFMPEG_FLAGS = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

/** How much of ffmpeg's own words a failure keeps: its last lines say what went wrong. */
const STDERR_TAIL = 2000;

/**
 * ffmpeg, as the stack's own images run it. Each run of segments is copied as one HLS playlist of local files, so the
 * segments keep their own timestamps: one run, the usual case, goes straight to the MP4. Several runs, after a seam
 * between sessions or a missing stretch, are each copied into an MP4 of their own first, then joined one after the
 * other, so each starts where the last ended and a missing stretch becomes a cut.
 *
 * ffmpeg reads only local files (`-protocol_whitelist file`), so nothing a playlist names can make it fetch anything.
 * `+faststart` puts the index at the front, so editors and players can open the file before reading all of it.
 */
export class FfmpegJoiner implements Joiner {
  constructor(
    private readonly ffmpeg = 'ffmpeg',
    private readonly ffprobe = 'ffprobe',
  ) {}

  async check(): Promise<string | null> {
    try {
      await execute(this.ffmpeg, ['-hide_banner', '-version']);
      await execute(this.ffprobe, ['-hide_banner', '-version']);
      return null;
    } catch {
      return "ffmpeg is not installed on the admin's server, so a recording cannot be joined into an MP4.";
    }
  }

  async join(runs: JoinRun[], output: string, workDir: string, signal?: AbortSignal): Promise<void> {
    if (runs.length === 0) throw new Error('there is nothing to join');
    if (runs.length === 1) {
      await this.copyRun(runs[0]!, 0, output, workDir, true, signal);
      return;
    }
    const parts: string[] = [];
    const list = path.join(workDir, 'runs.txt');
    try {
      for (const [index, run] of runs.entries()) {
        const part = path.join(workDir, `run-${index}.mp4`);
        parts.push(part);
        await this.copyRun(run, index, part, workDir, false, signal);
      }
      await writeFile(list, `${parts.map((part) => `file '${path.basename(part)}'`).join('\n')}\n`);
      await execute(
        this.ffmpeg,
        [
          ...FFMPEG_FLAGS,
          '-protocol_whitelist',
          'file',
          '-f',
          'concat',
          '-i',
          'runs.txt',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          output,
        ],
        { cwd: workDir, signal },
      );
    } finally {
      await Promise.all([...parts, list].map((file) => rm(file, { force: true })));
    }
  }

  async probeHeight(file: string): Promise<number | null> {
    const { stdout } = await execute(this.ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=height',
      '-of',
      'csv=p=0',
      file,
    ]);
    const height = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(height) && height > 0 ? height : null;
  }

  private async copyRun(
    run: JoinRun,
    index: number,
    output: string,
    workDir: string,
    faststart: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const playlist = `run-${index}.m3u8`;
    await writeFile(path.join(workDir, playlist), runPlaylist(run));
    try {
      await execute(
        this.ffmpeg,
        [
          ...FFMPEG_FLAGS,
          '-protocol_whitelist',
          'file',
          '-allowed_extensions',
          'ALL',
          '-i',
          playlist,
          '-c',
          'copy',
          '-bsf:a',
          'aac_adtstoasc',
          ...(faststart ? ['-movflags', '+faststart'] : []),
          '-f',
          'mp4',
          output,
        ],
        { cwd: workDir, signal },
      );
    } finally {
      await rm(path.join(workDir, playlist), { force: true });
    }
  }
}

/** A VOD playlist of local segment files: one run, so no seam and no missing segment inside it. */
export function runPlaylist(run: JoinRun): string {
  const longest = Math.max(1, ...run.durations.map((duration) => Math.ceil(duration)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${longest}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  run.files.forEach((file, index) => {
    lines.push(`#EXTINF:${(run.durations[index] ?? 0).toFixed(6)},`, file);
  });
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Runs a program to its end; a non-zero exit rejects with the tail of what it wrote to stderr. */
function execute(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} was stopped before it started`));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-STDERR_TAIL);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-STDERR_TAIL);
    });
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, signalName) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const said = stderr.trim().split('\n').slice(-3).join(' ').trim();
      reject(
        new Error(
          options.signal?.aborted
            ? `${command} was stopped`
            : `${command} exited with ${code === null ? `signal ${signalName}` : `code ${code}`}${said ? `: ${said}` : ''}`,
        ),
      );
    });
  });
}
