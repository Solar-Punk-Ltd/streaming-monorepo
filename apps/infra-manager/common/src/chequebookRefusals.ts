import type { TransferDirection } from './chequebook.js';

/**
 * Why the manager refused to prepare a chequebook transfer. The manager sets
 * one where it decides to refuse, and answers it with the 503. Nothing in
 * this list is ever filled from upstream text.
 */
export const CHEQUEBOOK_REFUSAL_CAUSES = [
  'bee_container_not_found',
  'bee_container_unsupported',
  'chain_endpoint_missing',
  'chain_setting_invalid',
  'chain_unreachable',
  'wrong_chain',
  'unsupported_chain',
  'target_changed',
  'bee_unreadable',
  'unavailable',
] as const;
export type ChequebookRefusalCause = (typeof CHEQUEBOOK_REFUSAL_CAUSES)[number];

export interface ChequebookRefusal {
  readonly cause: ChequebookRefusalCause;
}

export function chequebookRefusal(cause: ChequebookRefusalCause): ChequebookRefusal {
  const refusal = { cause };
  if (!isChequebookRefusal(refusal)) throw new Error('Not a chequebook refusal.');
  return Object.freeze(refusal);
}

export function isChequebookRefusal(value: unknown): value is ChequebookRefusal {
  if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'cause') return false;
  return (CHEQUEBOOK_REFUSAL_CAUSES as readonly unknown[]).includes((value as Record<string, unknown>).cause);
}

const NOTHING_SENT = 'Nothing was sent.';

const CAUSE_SENTENCES: Readonly<Record<ChequebookRefusalCause, string>> = Object.freeze({
  bee_container_not_found:
    'The manager has no Bee container recorded for this deployment. Deploy it from the manager, then try again.',
  bee_container_unsupported:
    "The Bee API port the deployment's container recorded is missing, out of range, or not the port the manager reserved for this deployment. Deploy it again from the manager, then try again.",
  chain_endpoint_missing:
    "The manager has no chain endpoint for the deployment's chain. Set FUNDING_RPC_URL or BEE_RPC_ENDPOINT, or name the chain in CHEQUEBOOK_RPC_ENDPOINTS, then restart the manager.",
  chain_setting_invalid:
    "The manager's CHEQUEBOOK_RPC_ENDPOINTS setting is malformed, or its default chain endpoint, FUNDING_RPC_URL or else BEE_RPC_ENDPOINT, is not a usable http or https address. Correct the setting, then restart the manager.",
  chain_unreachable:
    'The chain endpoint did not answer the manager. Check that the endpoint the manager reads this chain through, from CHEQUEBOOK_RPC_ENDPOINTS or else FUNDING_RPC_URL or BEE_RPC_ENDPOINT, can be reached from the manager, then try again.',
  wrong_chain:
    "The chain endpoint answered for a different chain than the Bee node runs on. Name an endpoint of the node's own chain in CHEQUEBOOK_RPC_ENDPOINTS, or point FUNDING_RPC_URL at one.",
  unsupported_chain:
    "The deployment's Bee node runs on a chain whose BZZ token this manager does not know. Transfers work on Gnosis Chain, Ethereum and Sepolia.",
  target_changed:
    'The deployment changed while the transfer was being prepared, or it is being deployed, stopped or removed. Wait until it is running and settled, or deploy it again, then try again.',
  bee_unreadable:
    "The deployment's Bee node did not answer, or answered inconsistently. Check that the node is running and synced, then try again.",
  unavailable: 'The node and chain could not be checked. Refresh the saved transfers before continuing.',
});

/** One plain sentence per refusal: what is wrong and what to do about it. */
export function chequebookRefusalSentence(refusal: ChequebookRefusal): string {
  return `${CAUSE_SENTENCES[refusal.cause]} ${NOTHING_SENT}`;
}

/** Why the manager's last check before sending refused a transfer it had already recorded. */
export const CHEQUEBOOK_PREFLIGHT_REFUSALS = [
  'preflight_failed',
  'preflight_no_gas',
  'preflight_insufficient_balance',
] as const;
export type ChequebookPreflightRefusal = (typeof CHEQUEBOOK_PREFLIGHT_REFUSALS)[number];

export function isChequebookPreflightRefusal(value: unknown): value is ChequebookPreflightRefusal {
  return (CHEQUEBOOK_PREFLIGHT_REFUSALS as readonly unknown[]).includes(value);
}

export function chequebookPreflightSentence(reason: ChequebookPreflightRefusal, direction: TransferDirection): string {
  if (reason === 'preflight_no_gas') {
    return "The node's wallet has no xDAI to pay gas with, so the manager refused this transfer before sending it. Send xDAI to the node's wallet, then start a new transfer.";
  }
  if (reason === 'preflight_insufficient_balance') {
    return direction === 'deposit'
      ? "The node's wallet holds less BZZ than this transfer asks for, so the manager refused it before sending it. Lower the amount or add BZZ to the wallet, then start a new transfer."
      : 'The chequebook has less available BZZ than this withdrawal asks for, so the manager refused it before sending it. Lower the amount, then start a new transfer.';
  }
  return "The manager's last check refused this transfer before it was sent. Start a new transfer once the node and the deployment are settled.";
}
