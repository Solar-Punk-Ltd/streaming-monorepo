import type { QoeContent } from './qoeContent';

/**
 * The QoE panel as a file, the panel's Copy and Save buttons: the panel top to bottom, every string as it prints it,
 * and nothing it does not show. `player` is there only when the panel shows the release line, and a row is its label
 * and value alone, since the colour of a bad value is the panel's and no string.
 */
export function qoeExportJson(content: QoeContent): string {
  return JSON.stringify(
    {
      title: content.title,
      ...(content.player !== null ? { player: content.player } : {}),
      sections: content.sections.map((section) => ({
        title: section.title,
        rows: section.rows.map(({ label, value }) => ({ label, value })),
      })),
      footer: content.footer,
    },
    null,
    2,
  );
}

/** The most of a topic that goes into a file name. */
const FILE_TOPIC_MAX = 64;

/** A stream's topic as a file name takes it: letters, digits, `.`, `_` and `-`, anything else one `-`. */
export function fileSafeTopic(topic: string | undefined): string {
  const safe = (topic ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, FILE_TOPIC_MAX)
    .replace(/^[-.]+|[-.]+$/g, '');
  return safe === '' ? 'stream' : safe;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `qoe-<stream>-<YYYYMMDD-HHMMSS>.json`, the stream's topic made file-safe and the time in the viewer's own zone. */
export function qoeExportFileName(topic: string | undefined, at: Date): string {
  const date = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
  const time = `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `qoe-${fileSafeTopic(topic)}-${date}-${time}.json`;
}

/** What Copy came to: on the clipboard, or refused by the browser, as it refuses a page served over plain http. */
type QoeCopyOutcome = 'copied' | 'refused';

/** What Copy says when the browser refused it. Save still works, so it points there. */
export const QOE_COPY_REFUSED =
  'The browser refused the clipboard here, as it does on a page served over plain http. Save still works.';

export const QOE_COPIED = 'Copied';

/** What Copy reaches the clipboard through, the browser's own when left out. */
interface QoeCopyDeps {
  /** The asynchronous clipboard, which a browser offers only to a page served over https or on localhost. */
  clipboard?: Pick<Clipboard, 'writeText'> | undefined;
  /** The older copy of a selection, which some browsers still allow where the clipboard is refused. */
  copySelection?: (text: string) => boolean;
}

/** The older way to copy: a hidden text area selected and copied, true when the browser says it copied. */
function copyThroughSelection(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Puts the JSON on the clipboard: the asynchronous clipboard first, then the older copy of a selection, and `refused`
 * when the browser takes neither. Never throws.
 */
export async function copyQoeExport(json: string, deps: QoeCopyDeps = {}): Promise<QoeCopyOutcome> {
  const clipboard = 'clipboard' in deps ? deps.clipboard : globalThis.navigator?.clipboard;
  const copySelection = deps.copySelection ?? copyThroughSelection;
  if (clipboard) {
    try {
      await clipboard.writeText(json);
      return 'copied';
    } catch {
      // Refused, or the page lost focus: the older way may still be allowed.
    }
  }
  try {
    return copySelection(json) ? 'copied' : 'refused';
  } catch {
    return 'refused';
  }
}

/**
 * How long a saved file's address is kept after the click. WebKit starts a `blob:` download only after the click has
 * returned, and an address let go at once is the known cause of a Safari download that fails; FileSaver.js waits 40 s.
 */
export const QOE_SAVE_REVOKE_MS = 40_000;

/** What Save downloads through, the browser's own when left out. */
interface QoeSaveDeps {
  document?: Pick<Document, 'createElement' | 'body'>;
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

/** Downloads the JSON as a file of this name, which works wherever the page is served, plain http included. */
export function saveQoeExport(json: string, fileName: string, deps: QoeSaveDeps = {}): void {
  const doc = deps.document ?? document;
  const url = deps.url ?? URL;
  const href = url.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = href;
  link.download = fileName;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => url.revokeObjectURL(href), QOE_SAVE_REVOKE_MS);
  }
}
