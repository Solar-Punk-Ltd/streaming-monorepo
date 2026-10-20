import {
  chequebookRefusal,
  chequebookRefusalSentence,
  type ChequebookRefusalCause,
} from '@streaming-infra-manager/common';
import { TransferRefusalError } from './TransferRefusalError.js';

/** A transfer the manager refused to prepare. Its message is the sentence the page shows for its cause. */
export class ChequebookPreparationError extends TransferRefusalError {
  constructor(cause: ChequebookRefusalCause = 'unavailable') {
    super(chequebookRefusalSentence(chequebookRefusal(cause)), cause);
    this.name = 'ChequebookPreparationError';
  }

  /** A fresh refusal that keeps the cause a caught manager error carried, so the caught error goes no further. */
  static keeping(error: unknown, fallback: ChequebookRefusalCause = 'unavailable'): ChequebookPreparationError {
    const carried = TransferRefusalError.carried(error);
    return carried ? new ChequebookPreparationError(carried.cause) : new ChequebookPreparationError(fallback);
  }
}
