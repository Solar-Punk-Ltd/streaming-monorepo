import { IconButton, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

import { copyText } from '../clipboard';
import { useSnackbar } from './Snackbar';

export function CopyButton({
  value,
  label,
  onCopyUnavailable,
}: {
  value: string;
  label: string;
  /**
   * Last resort when neither clipboard route works: select the value on
   * screen so the operator can copy it by hand. `ValueField` wires this up.
   */
  onCopyUnavailable?: () => void;
}) {
  const snackbar = useSnackbar();
  const name = label.toLowerCase();

  const copy = async () => {
    if ((await copyText(value)) === 'copied') {
      snackbar.success(`${label} copied to your clipboard.`);
      return;
    }
    if (onCopyUnavailable) {
      onCopyUnavailable();
      snackbar.error(
        `This browser will not let the page copy for you. The ${name} is ` +
          'selected — copy it with your keyboard.',
      );
      return;
    }
    snackbar.error(`Could not copy the ${name}.`);
  };

  return (
    <Tooltip title={`Copy ${name}`}>
      <IconButton
        size="small"
        aria-label={`copy ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        <ContentCopyIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}
