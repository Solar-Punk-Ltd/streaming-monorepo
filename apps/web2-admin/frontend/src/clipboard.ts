/**
 * Copying to the clipboard, degrading twice.
 *
 * `navigator.clipboard` only exists in a secure context, and the console is
 * deployed over plain http on an IP address, so on the host that matters it is
 * simply undefined. Every OBS value is something the operator has to paste
 * into an encoder, so a Copy button that cannot copy is not an option:
 * `document.execCommand('copy')` is deprecated but works everywhere, over
 * http included, and is the one that will actually run in production.
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
