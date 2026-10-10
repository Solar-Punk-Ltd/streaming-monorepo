import {
  BEE_UPLOADER_SERVICE,
  type ChequebookAdmissionDetail,
  type ChequebookOperation,
  chequebookPreflightSentence,
  chequebookRefusalSentence,
  isChequebookPreflightRefusal,
  plurToBzzExact,
} from '@streaming-infra-manager/common';
import type {
  FundingChequebookOperationAnswer,
  FundingChequebookOperationRequest,
  FundingChequebookOperationStatus,
  FundingInventory,
  FundingNode,
  FundingTransferState,
} from '@streaming-monorepo/contracts';

import type { Profile } from '../../types/index.js';
import type { ChequebookOperationsService } from '../chequebook/ChequebookOperationsService.js';
import { ChequebookOperationNotFoundError } from '../errors/ChequebookOperationNotFoundError.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import { ChequebookProfileChangedError } from '../errors/ChequebookProfileChangedError.js';
import { Logger } from '../Logger.js';
import { FundingApiError } from './FundingApiError.js';

const logger = Logger.getInstance();

/**
 * Who the chequebook journal records as having asked for a move that came through the funding API. An operator's own
 * transfer is recorded as `user:<id>`, so the manager console never takes one of these for the signed-in operator's.
 */
export const FUNDING_CHEQUEBOOK_REQUESTER = 'web2-admin';

/** The least time between two checks of one operation that status reads have the manager make, per request id. */
export const FUNDING_CHEQUEBOOK_CHECK_MS = 30_000;

/**
 * How long a status read waits for that check before it answers the journal as it stands. The check runs on and
 * journals what it finds, which a later read answers. Well inside the ten seconds the web2 admin waits for a read.
 */
export const FUNDING_CHEQUEBOOK_CHECK_WAIT_MS = 5_000;

export interface FundingChequebookDeps {
  /**
   * The manager's own chequebook path and its journal, `ChequebookOperationsService`, which moves the transfers an
   * operator starts on the deployment page too.
   */
  operations: Pick<ChequebookOperationsService, 'submit' | 'byRequestId' | 'check'>;
  /** The nodes with their wallets and their chequebooks, read now, `FundingInventoryService`. */
  inventory: { inventory(): Promise<FundingInventory> };
  /** The deployment whose own Bee node a node id names, or null when this manager runs none now. */
  deployment(nodeId: string): Promise<Pick<Profile, 'name' | 'instance_id'> | null>;
  now?: () => number;
  /** How long a status read waits for a check, {@link FUNDING_CHEQUEBOOK_CHECK_WAIT_MS} by default. */
  checkWaitMs?: number;
}

const ONLY_OWN = 'This manager moves only the chequebook of a stage’s Bee node or a rung.';
const NO_CHEQUEBOOK = 'The node answered that it has no chequebook, so there is none to move xBZZ in or out of.';
const NO_GAS = 'The node’s wallet holds no xDAI to pay the gas with.';
const BUSY = 'Another chequebook move on this node is still under way.';
const OTHER_MOVE = 'This request id names another chequebook operation.';
const PROFILE_CHANGED = 'The node’s deployment was removed or replaced. Nothing was sent.';
const REVERTED = 'The chain reverted the move; nothing moved.';
const NOT_KNOWN =
  'The manager could not tell whether the node made the move; its chequebook history in the manager can settle it.';
const ASSERTED = 'An operator recorded in the manager that the move was never made.';

function refused(message: string): FundingApiError {
  return new FundingApiError('chequebook_refused', message);
}

function unknownNode(): FundingApiError {
  return new FundingApiError('unknown_node', 'No node of this manager has this id.');
}

/**
 * The node whose chequebook a request moves, as the inventory read it now: a stage's own Bee node or a rung, wherever
 * a stage lists it. A gateway, and the catalogue node where no stage lists it, are refused, since the chequebook path
 * moves only a deployment's own `bee-uploader` and only these are the stages'. A node listed nowhere is unknown.
 */
function movableNode(inventory: FundingInventory, nodeId: string): FundingNode {
  const listed = inventory.stages.flatMap((stage) => stage.nodes).filter((node) => node.nodeId === nodeId);
  const movable = listed.find((node) => node.role === 'uploader' || node.role === 'rung');
  if (movable) return movable;
  if (listed.length > 0 || inventory.catalogue?.nodeId === nodeId) throw refused(ONLY_OWN);
  throw unknownNode();
}

/**
 * The checks the inventory read now answers, before anything is journalled: the node's wallet and its chequebook were
 * read, a deposit is within the wallet's xBZZ and a withdrawal within what the chequebook has available, and the
 * wallet holds some xDAI for the gas either takes. The chequebook path reads the node again in its own last check.
 */
function checkFunds(node: FundingNode, request: FundingChequebookOperationRequest): void {
  if (node.xbzzPlur === null || node.xdaiWei === null) {
    throw refused(
      `The node’s wallet could not be read, so whether it can pay is not known. ${node.readError ?? ''}`.trim(),
    );
  }
  const chequebook = node.chequebook;
  if (chequebook === null) throw refused(NO_CHEQUEBOOK);
  if (chequebook === undefined || chequebook.availablePlur === null) {
    throw refused(
      `The node’s chequebook could not be read, so the move is not made now. ${chequebook?.readError ?? ''}`.trim(),
    );
  }
  const amount = BigInt(request.amountPlur);
  if (request.direction === 'deposit') {
    const xbzz = BigInt(node.xbzzPlur);
    if (xbzz < amount) {
      throw refused(
        `The node’s wallet holds ${plurToBzzExact(xbzz)} xBZZ, less than the ${plurToBzzExact(amount)} xBZZ this deposit moves.`,
      );
    }
  } else {
    const available = BigInt(chequebook.availablePlur);
    if (available < amount) {
      throw refused(
        `The chequebook has ${plurToBzzExact(available)} xBZZ available, less than the ${plurToBzzExact(amount)} xBZZ this withdrawal moves.`,
      );
    }
  }
  if (BigInt(node.xdaiWei) === 0n) throw refused(NO_GAS);
}

/**
 * A request id the journal holds already: its operation when it is the same move the funding API asked for, on the
 * same node, in the same direction and of the same amount, and a conflict otherwise, an operator's own transfer
 * under that id included.
 */
function sameMove(operation: ChequebookOperation, request: FundingChequebookOperationRequest): ChequebookOperation {
  const same =
    operation.requestedBy === FUNDING_CHEQUEBOOK_REQUESTER &&
    operation.profileInstanceId !== null &&
    `${operation.profileInstanceId}:${BEE_UPLOADER_SERVICE}` === request.nodeId &&
    operation.direction === request.direction &&
    operation.amountPlur === request.amountPlur;
  if (!same) throw new FundingApiError('conflict', OTHER_MOVE);
  return operation;
}

/** An `operate()` under way in this process: the request it carries, and the promise of its answer or its refusal. */
interface UnderWay {
  readonly request: FundingChequebookOperationRequest;
  readonly answer: Promise<FundingChequebookOperationAnswer>;
}

/** Whether a request sent under the id of one under way is the same move: same node, same direction, same amount. */
function sameRequest(a: FundingChequebookOperationRequest, b: FundingChequebookOperationRequest): boolean {
  return a.nodeId === b.nodeId && a.direction === b.direction && a.amountPlur === b.amountPlur;
}

/**
 * A refusal of the chequebook path's that came before anything was journalled or sent, with the manager's own sentence
 * for its cause, or null for any other failure, which is the manager's own error: a journal that could not be
 * written or read leaves the move not known, never refused.
 */
function preparationRefusal(err: unknown): FundingApiError | null {
  if (err instanceof ChequebookPreparationError) return refused(chequebookRefusalSentence(err.refusal));
  if (err instanceof ChequebookProfileChangedError) return refused(PROFILE_CHANGED);
  return null;
}

/** Why a move the chequebook path's last check refused before sending it failed, in its own sentence. */
function rejectionOf(operation: ChequebookOperation): string {
  const reason = isChequebookPreflightRefusal(operation.failureReason) ? operation.failureReason : 'preflight_failed';
  return chequebookPreflightSentence(reason, operation.direction);
}

/** A journalled operation in the transfers' four states, with a sentence for one that failed or is not known. */
function outcomeOf(operation: ChequebookOperation): { state: FundingTransferState; error: string | null } {
  // Two operations' evidence naming one transaction takes precedence over either's state, until an operator reviews it.
  if (operation.failureReason === 'hash_conflict') return { state: 'unknown', error: NOT_KNOWN };
  switch (operation.state) {
    case 'submitting':
    case 'submitted':
      return { state: 'submitted', error: null };
    case 'settled':
      return { state: 'confirmed', error: null };
    case 'reverted':
      return { state: 'failed', error: REVERTED };
    case 'rejected':
      return { state: 'failed', error: rejectionOf(operation) };
    case 'asserted':
      return { state: 'failed', error: ASSERTED };
    case 'unknown':
      return { state: 'unknown', error: NOT_KNOWN };
  }
}

/**
 * Whether a journalled move's transaction is in a block that is not final yet: the row maps to `submitted`, and the
 * chequebook path's last look at its receipt found it pending for finality. The chequebook path settles a move only
 * once its block is final, about 3 minutes after it is mined on Gnosis Chain, and its receipt polling looks every
 * `RECEIPT_POLL_INTERVAL_MS`, so a move reads `submitted` for those minutes, mined.
 */
function isMined(operation: ChequebookOperation): boolean {
  const observation = operation.receiptObservation;
  return (
    outcomeOf(operation).state === 'submitted' &&
    observation?.kind === 'pending' &&
    observation.reason === 'awaiting_finality'
  );
}

function answerOf(operation: ChequebookOperation): FundingChequebookOperationAnswer {
  return {
    requestId: operation.requestId,
    direction: operation.direction,
    state: outcomeOf(operation).state,
    txHash: operation.transactionHash,
  };
}

/**
 * Whether a status read has the manager check an operation first: one `submitting` or `unknown`, which only a look at
 * the chain settles, and one `submitted` that the manager's receipt polling no longer reads, past its
 * `receiptPollUntil` or with none.
 */
function awaitsCheck(operation: ChequebookOperation, now: number): boolean {
  if (operation.state === 'submitting' || operation.state === 'unknown') return true;
  if (operation.state !== 'submitted') return false;
  const until = operation.receiptPollUntil === null ? Number.NaN : Date.parse(operation.receiptPollUntil);
  return !(until > now);
}

/** What a promise that never rejects comes to within `ms`, or null when it has not settled by then. It runs on. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The funding API's chequebook operations: a deposit into, or a withdrawal from, the chequebook of a stage's own Bee
 * node or a rung, which the node carries out and pays the gas of in xDAI. A thin adapter over the manager's own
 * chequebook path, `ChequebookOperationsService`, the one behind the deployment page's Fill chequebook and Withdraw:
 * the same preparation over the node's own Docker connection, the same last check before sending, the same single
 * POST to the node and the same journal, `chequebook_operations`, where the move is recorded as requested by
 * `web2-admin`. This adapter journals nothing of its own.
 *
 * A request id the journal holds already answers that operation's state when it is the same move, and a conflict
 * otherwise, before the inventory is read: a replay answers even when the node has gone, and the chequebook path
 * never runs one request twice.
 *
 * Otherwise the move is checked against the inventory read now, and each refusal comes before anything is journalled:
 * the node is a stage's own Bee node or a rung (404 `unknown_node` for one listed nowhere, and 422
 * `chequebook_refused` for a gateway or the catalogue node no stage lists), its wallet and its chequebook were read, a
 * deposit is within the wallet's xBZZ, a withdrawal within what the chequebook has available, and the wallet holds
 * some xDAI for the gas. Then the chequebook path takes it, and checks the node and the chain again before it sends.
 * What it could not prepare is refused with its own sentence for the cause, and another move still under way on the
 * node is a conflict.
 *
 * Its states are the transfers' four: `submitting` and `submitted` are `submitted`, `settled` is `confirmed`, a move
 * the chain reverted, the last check refused or an operator recorded as never made is `failed` with a sentence, and
 * `unknown` stays `unknown`, as does any row whose evidence conflicts with another's. A status read has the chequebook
 * path check an open operation first, at most once every {@link FUNDING_CHEQUEBOOK_CHECK_MS} per request id, and
 * answers the journal as it stands when that check fails or takes longer than {@link FUNDING_CHEQUEBOOK_CHECK_WAIT_MS}.
 * It answers `mined` true while a `submitted` move's transaction is in a block that is not final yet, the chequebook
 * path's last look at its receipt having found it pending for finality, and false otherwise: the path settles a move
 * only once its block is final, minutes after it is mined.
 *
 * The chequebook path journals a move only once it has prepared it, which can take it half a minute, so until then
 * the request is known by its call under way in this process, the manager's one API process. A status read of a
 * request id nothing is journalled under yet, whose call is under way, answers it `submitted` with no hash and no
 * error, never `unknown_request`, on which the web2 admin would send it again. The same request sent again meanwhile
 * waits for that call and answers what it answered, the same refusal when it was refused, and another move under its
 * id is a conflict at once; neither reads anything or runs beside it. The id is freed once the call has answered.
 */
export class FundingChequebookService {
  private readonly now: () => number;
  private readonly checkWaitMs: number;
  /** When a status read last had each request id's operation checked, for {@link FUNDING_CHEQUEBOOK_CHECK_MS}. */
  private readonly lastCheck = new Map<string, number>();
  /** The request ids whose `operate()` is under way in this process, from its first step until it has answered. */
  private readonly underWay = new Map<string, UnderWay>();

  constructor(private readonly deps: FundingChequebookDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.checkWaitMs = deps.checkWaitMs ?? FUNDING_CHEQUEBOOK_CHECK_WAIT_MS;
  }

  async operate(request: FundingChequebookOperationRequest): Promise<FundingChequebookOperationAnswer> {
    const running = this.underWay.get(request.requestId);
    if (running) {
      if (!sameRequest(running.request, request)) throw new FundingApiError('conflict', OTHER_MOVE);
      return running.answer;
    }
    const answer = this.carryOut(request);
    this.underWay.set(request.requestId, { request, answer });
    try {
      return await answer;
    } finally {
      this.underWay.delete(request.requestId);
    }
  }

  async status(requestId: string): Promise<FundingChequebookOperationStatus> {
    const journalled = await this.journalled(requestId);
    // Looked up after the journal read, so a call that has answered by now is never taken for one under way.
    const running = journalled ? undefined : this.underWay.get(requestId);
    if (running) {
      return {
        requestId,
        direction: running.request.direction,
        state: 'submitted',
        txHash: null,
        error: null,
        mined: false,
      };
    }
    // An operator's own transfer under this id is not the funding API's to answer: the admin's request was never taken.
    if (!journalled || journalled.requestedBy !== FUNDING_CHEQUEBOOK_REQUESTER) {
      throw new FundingApiError(
        'unknown_request',
        'The funding API journalled no chequebook operation under this request id, so sending it again under the same id is safe.',
      );
    }
    const operation = awaitsCheck(journalled, this.now()) ? await this.checked(journalled) : journalled;
    const { state, error } = outcomeOf(operation);
    if (state === 'confirmed' || state === 'failed') this.lastCheck.delete(operation.requestId);
    return {
      requestId: operation.requestId,
      direction: operation.direction,
      state,
      txHash: operation.transactionHash,
      error,
      mined: isMined(operation),
    };
  }

  /**
   * One request carried out: answered from the journal when its id is journalled already, otherwise checked against
   * the inventory read now and handed to the chequebook path.
   */
  private async carryOut(request: FundingChequebookOperationRequest): Promise<FundingChequebookOperationAnswer> {
    const known = await this.journalled(request.requestId);
    if (known) return answerOf(sameMove(known, request));

    const node = movableNode(await this.deps.inventory.inventory(), request.nodeId);
    const deployment = await this.deps.deployment(request.nodeId);
    if (!deployment) throw unknownNode();
    checkFunds(node, request);

    let admission: ChequebookAdmissionDetail;
    try {
      admission = await this.deps.operations.submit({
        requestId: request.requestId,
        profileName: deployment.name,
        profileInstanceId: deployment.instance_id,
        requestedBy: FUNDING_CHEQUEBOOK_REQUESTER,
        direction: request.direction,
        amountPlur: request.amountPlur,
      });
    } catch (err) {
      const refusal = preparationRefusal(err);
      if (refusal) throw refusal;
      throw err;
    }
    if (admission.kind === 'busy') throw new FundingApiError('conflict', BUSY);
    if (admission.kind === 'conflict') throw new FundingApiError('conflict', OTHER_MOVE);
    const { operation } = admission;
    logger.info(
      `[Funding] chequebook ${operation.direction} ${operation.requestId} of ${operation.amountPlur} PLUR on ${request.nodeId} is ${operation.state}${
        operation.transactionHash ? `, ${operation.transactionHash}` : ''
      }`,
    );
    return answerOf(operation);
  }

  /** The operation journalled under a request id, or null. A journal that cannot be read is the manager's own error. */
  private async journalled(requestId: string): Promise<ChequebookOperation | null> {
    try {
      return (await this.deps.operations.byRequestId(requestId)).operation;
    } catch (err) {
      if (err instanceof ChequebookOperationNotFoundError) return null;
      throw err;
    }
  }

  /**
   * The operation once the chequebook path has checked it on the chain, or as it was journalled when it was checked
   * less than {@link FUNDING_CHEQUEBOOK_CHECK_MS} ago, when the check fails, or when it is still under way after
   * {@link FUNDING_CHEQUEBOOK_CHECK_WAIT_MS}. Never throws.
   */
  private async checked(operation: ChequebookOperation): Promise<ChequebookOperation> {
    const now = this.now();
    const last = this.lastCheck.get(operation.requestId);
    if (last !== undefined && now - last < FUNDING_CHEQUEBOOK_CHECK_MS) return operation;
    this.lastCheck.set(operation.requestId, now);
    const check = this.deps.operations.check(operation.id).then(
      (detail) => detail.operation,
      (err: unknown) => {
        // The name alone: a failure's text is the chequebook path's to log.
        logger.debug(
          `[Funding] could not check chequebook operation ${operation.requestId} (${err instanceof Error ? err.name : 'no error'}); answering it as journalled`,
        );
        return null;
      },
    );
    return (await within(check, this.checkWaitMs)) ?? operation;
  }
}
