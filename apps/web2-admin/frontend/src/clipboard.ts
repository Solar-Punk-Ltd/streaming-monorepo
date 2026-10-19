/**
 * Copying to the clipboard, degrading twice.
 *
 * `navigator.clipboard` exists only in a secure context. Behind the host's edge
 * and on a localhost tunnel the console has one, but a console reached over
 * plain http at an IP address does not. Every OBS value is something the
 * operator has to paste into an encoder, so a Copy button that cannot copy is
 * not an option: Copy falls back to `document.execCommand('copy')`, deprecated
 * but working over http too, and, failing that, to selecting the value.
 */
export type CopyOutcome = 'copied' | 'unavailable';

function copyWithExecCommand(value: string): boolean {
  if (typeof document.execCommand !== 'function') return false;

  const holder = document.createElement('textarea');
  holder.value = value;
  // Off-screen but focusable: `display:none` or `hidden` would make the
  // selection — and therefore the copy — fail.
  holder.setAttribute('readonly', '');
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.style.opacity = '0';
  document.body.appendChild(holder);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    holder.select();
    holder.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(holder);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

export async function copyText(value: string): Promise<CopyOutcome> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return 'copied';
    } catch {
      // Denied permission or an insecure context that still exposes the API;
      // fall through to the command that does not need one.
    }
  }
  return copyWithExecCommand(value) ? 'copied' : 'unavailable';
}
