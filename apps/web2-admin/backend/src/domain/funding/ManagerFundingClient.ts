import {
  FUNDING_CHEQUEBOOK_OPERATIONS_PATH,
  FUNDING_INVENTORY_PATH,
  FUNDING_STAMP_OPERATIONS_PATH,
  FUNDING_TRANSFERS_PATH,
  type FundingAccountAnswer,
  fundingAccountAnswerSchema,
  fundingAccountPath,
  type FundingChequebookOperationAnswer,
  fundingChequebookOperationAnswerSchema,
  fundingChequebookOperationPath,
  type FundingChequebookOperationRequest,
  type FundingChequebookOperationStatus,
  fundingChequebookOperationStatusSchema,
  type FundingErrorCode,
  fundingErrorAnswerSchema,
  type FundingInventory,
  fundingInventorySchema,
  type FundingStampOperationAnswer,
  fundingStampOperationAnswerSchema,
  fundingStampOperationPath,
  type FundingStampOperationRequest,
  type FundingStampOperationStatus,
  fundingStampOperationStatusSchema,
  type FundingTransferAnswer,
  fundingTransferAnswerSchema,
  fundingTransferPath,
  type FundingTransferRequest,
  type FundingTransferStatus,
  fundingTransferStatusSchema,
} from '@streaming-monorepo/contracts';

import {
  MANAGER_FUNDING_URL_KEY,
  managerFundingBaseUrl,
  managerFundingTokenProblem,
  managerFundingUrlProblem,
} from '../../utils/fundingSettings.js';

/**
 * The client of the manager's funding API (`packages/contracts/src/funding.ts`, docs/architecture/funding.md): the
 * stages' nodes with their wallets, batches and chequebooks, the brand wallet's account, the transfers the admin signs
 * and the manager sends, and the stamp and chequebook operations the manager asks the nodes for. The funding services
 * are its users.
 *
 * Every request carries `Authorization: Bearer <MANAGER_FUNDING_TOKEN>` to the manager's address and nowhere else:
 * the address is held to the funding rules (https, or plain http to this host), and no redirect is followed. Each
 * call has a deadline that covers its answer read whole, and reads a bounded answer. Every answer is parsed by the
 * contract's schema, so the client answers the contract's shape and nothing more, and every failure is a
 * {@link ManagerFundingError}. The client logs nothing, and no error carries the token.
 */

/** How long a call may take, its answer read whole, unless the client is given another deadline. */
export const MANAGER_FUNDING_TIMEOUT_MS = 10_000;

/**
 * How long a stamp operation's call may take, its answer read whole, unless the client is given another deadline. The
 * manager answers it only once the node has: a node answers a top-up once its approval and its top-up are mined, and
 * a dilution once it is mined, and the manager gives a node 180 seconds for a call that waits on the chain
 * (`ON_CHAIN_TIMEOUT_MS` in its `BeeClient.ts`). This leaves room for the manager's own checks besides.
 */
export const MANAGER_FUNDING_STAMP_TIMEOUT_MS = 200_000;

/**
 * How long a chequebook operation's call may take, its answer read whole, unless the client is given another
 * deadline: the 240 seconds the manager's edge gives its funding API (`proxy_read_timeout` of `/api/admin-funding` in
 * the manager's `frontend/nginx.conf`). The manager answers it once it has reached the node, prepared the move,
 * journalled it and had the node's answer to it: seconds as a rule, and about 230 at worst, 15 to reach the node's Bee
 * API, 30 to prepare the move and the 180 it gives the node's answer, with its cleanup after. An answer lost past this
 * deadline is read on the status route, which answers the operation, since the manager journals it before it asks the
 * node.
 */
export const MANAGER_FUNDING_CHEQUEBOOK_TIMEOUT_MS = 240_000;

/**
 * The largest answer the client reads, the bound the manager's own chain client keeps. An inventory of a hundred
 * stages is a small part of it.
 */
export const MANAGER_FUNDING_MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/**
 * How a call can fail besides a refusal with one of the contract's codes:
 * - `unreachable`: the manager could not be reached, or the connection failed before a whole answer came;
 * - `timeout`: no whole answer before the deadline;
 * - `not_json`: an answer whose body is not JSON;
 * - `bad_answer`: JSON that is not what the contract says the route answers, an error answer without one of the
 *   contract's codes, an answer over the size limit, or a redirect, which is not followed.
 */
export const MANAGER_FUNDING_FAILURES = ['unreachable', 'timeout', 'not_json', 'bad_answer'] as const;
export type ManagerFundingFailure = (typeof MANAGER_FUNDING_FAILURES)[number];

/**
 * A call to the manager's funding API that did not get the answer it asked for. `code` is one of the contract's
 * codes (`FUNDING_ERROR_CODES`) when the manager refused with one, with `status` the HTTP status it answered and the
 * message its sentence. Otherwise it is one of {@link MANAGER_FUNDING_FAILURES}, with `status` the answer's, or null
 * when no answer came. After `relay`, `unreachable` and `timeout` leave it unknown whether the manager took the
 * transfer: relaying it again under the same request id answers its state, and the manager never sends it twice. A
 * status read that answers `unknown_request` says the manager journalled no transfer under the id, so the relay never
 * reached it and relaying again is safe; `unknown_node` refuses the node. A stamp or chequebook operation's status
 * read answers `unknown_request` in the same way, when the manager journalled no such operation under the id.
 */
export class ManagerFundingError extends Error {
  readonly code: FundingErrorCode | ManagerFundingFailure;
  readonly status: number | null;

  constructor(
    code: FundingErrorCode | ManagerFundingFailure,
    status: number | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagerFundingError';
    this.code = code;
    this.status = status;
  }
}

export interface ManagerFundingClientOptions {
  /** The manager's address, as `config.managerFunding.url` holds it. Held to the funding rules here as well. */
  url: string;
  /** The manager's `FUNDING_API_TOKEN`, sent as `Authorization: Bearer` with every request. */
  token: string;
  /** The deadline of one call, its answer read whole, in ms. {@link MANAGER_FUNDING_TIMEOUT_MS} by default. */
  timeoutMs?: number;
  /**
   * The deadline of a stamp operation's call, its answer read whole, in ms. {@link MANAGER_FUNDING_STAMP_TIMEOUT_MS}
   * by default. A stamp operation's status read keeps `timeoutMs`.
   */
  stampTimeoutMs?: number;
  /**
   * The deadline of a chequebook operation's call, its answer read whole, in ms.
   * {@link MANAGER_FUNDING_CHEQUEBOOK_TIMEOUT_MS} by default. A chequebook operation's status read keeps `timeoutMs`.
   */
  chequebookTimeoutMs?: number;
  /** The largest answer read, in bytes. {@link MANAGER_FUNDING_MAX_ANSWER_BYTES} by default. */
  maxAnswerBytes?: number;
  /** The fetch to call: the global one by default, a fake in the unit tests. */
  fetch?: typeof fetch;
}

/** What the client needs of a contract schema: a parse that says why it failed rather than throwing. */
interface AnswerSchema<T> {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/** Where a schema first found the answer wrong, as `path: message`. Names what was expected, never a value. */
function firstIssue(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'it does not parse';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * The answer's body, `maxBytes` of it at most: refused unread when its length says it is longer, and refused once it
 * runs past the limit. The signal cancels a body that stops arriving, whether or not the fetch ties it to the body.
 */
async function readAnswer(response: Response, signal: AbortSignal, maxBytes: number, route: string): Promise<Buffer> {
  const tooLarge = () =>
    new ManagerFundingError(
      'bad_answer',
      response.status,
      `The manager's answer to ${route} is over ${maxBytes} bytes.`,
    );
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

export class ManagerFundingClient {
  // The language's private fields rather than TypeScript's, so no view of the object shows the token.
  readonly #base: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #stampTimeoutMs: number;
  readonly #chequebookTimeoutMs: number;
  readonly #maxAnswerBytes: number;
  readonly #fetch: typeof fetch;

  /** Throws for an address or a token the funding rules refuse, in a sentence that repeats neither. */
  constructor(options: ManagerFundingClientOptions) {
    const problem = managerFundingUrlProblem(options.url) ?? managerFundingTokenProblem(options.token);
    if (problem) throw new Error(problem);
    const timeoutMs = options.timeoutMs ?? MANAGER_FUNDING_TIMEOUT_MS;
    const stampTimeoutMs = options.stampTimeoutMs ?? MANAGER_FUNDING_STAMP_TIMEOUT_MS;
    const chequebookTimeoutMs = options.chequebookTimeoutMs ?? MANAGER_FUNDING_CHEQUEBOOK_TIMEOUT_MS;
    const maxAnswerBytes = options.maxAnswerBytes ?? MANAGER_FUNDING_MAX_ANSWER_BYTES;
    for (const deadline of [timeoutMs, stampTimeoutMs, chequebookTimeoutMs]) {
      if (!Number.isSafeInteger(deadline) || deadline < 1) {
        throw new Error("The funding client's deadline must be a whole number of milliseconds above 0.");
      }
    }
    if (!Number.isSafeInteger(maxAnswerBytes) || maxAnswerBytes < 1) {
      throw new Error("The funding client's answer limit must be a whole number of bytes above 0.");
    }
    this.#base = managerFundingBaseUrl(options.url);
    this.#token = options.token;
    this.#timeoutMs = timeoutMs;
    this.#stampTimeoutMs = stampTimeoutMs;
    this.#chequebookTimeoutMs = chequebookTimeoutMs;
    this.#maxAnswerBytes = maxAnswerBytes;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** `GET /api/admin-funding/inventory`: every stage's nodes and the catalogue node, with their wallets. */
  async inventory(): Promise<FundingInventory> {
    return this.#call('GET', FUNDING_INVENTORY_PATH, fundingInventorySchema);
  }

  /**
   * `GET /api/admin-funding/accounts/:address`: the account's balances, pending nonce, fees and gas limits. Throws,
   * asking nothing, for what is not an address.
   */
  async account(address: string): Promise<FundingAccountAnswer> {
    return this.#call('GET', fundingAccountPath(address), fundingAccountAnswerSchema);
  }

  /**
   * `POST /api/admin-funding/transfers`: one signed transfer, which the manager checks, journals and sends. Only the
   * contract's fields go. The same request id sent again answers the transfer's state and never sends it twice, so a
   * relay that ended in `unreachable` or `timeout` is made again as it was.
   */
  async relay(transfer: FundingTransferRequest): Promise<FundingTransferAnswer> {
    const { requestId, nodeId, kind, to, amount, rawTransaction } = transfer;
    return this.#call('POST', FUNDING_TRANSFERS_PATH, fundingTransferAnswerSchema, {
      requestId,
      nodeId,
      kind,
      to,
      amount,
      rawTransaction,
    });
  }

  /**
   * `GET /api/admin-funding/transfers/:requestId`: where a transfer stands. `unknown_request` (404) when the manager
   * journalled no transfer under the id. Throws, asking nothing, for what is not a UUID.
   */
  async status(requestId: string): Promise<FundingTransferStatus> {
    return this.#call('GET', fundingTransferPath(requestId), fundingTransferStatusSchema);
  }

  /**
   * `POST /api/admin-funding/stamp-operations`: one top-up or dilution of a node's batch, which the manager checks,
   * journals and asks the node for. Only the contract's fields of the operation's kind go. The manager answers once
   * the node has, so the call has its own, longer deadline ({@link MANAGER_FUNDING_STAMP_TIMEOUT_MS}). The same
   * request id sent again with the same fields answers the operation's state and never runs it twice, so a call that
   * ended in `unreachable` or `timeout` is made again as it was, once a status read says the manager never received it.
   */
  async stampOperation(operation: FundingStampOperationRequest): Promise<FundingStampOperationAnswer> {
    const { requestId, nodeId, batchId, expectedDepth } = operation;
    const body =
      operation.kind === 'topup'
        ? {
            requestId,
            kind: operation.kind,
            nodeId,
            batchId,
            expectedDepth,
            amountPerChunkPlur: operation.amountPerChunkPlur,
          }
        : { requestId, kind: operation.kind, nodeId, batchId, expectedDepth, newDepth: operation.newDepth };
    return this.#call(
      'POST',
      FUNDING_STAMP_OPERATIONS_PATH,
      fundingStampOperationAnswerSchema,
      body,
      this.#stampTimeoutMs,
    );
  }

  /**
   * `GET /api/admin-funding/stamp-operations/:requestId`: where a stamp operation stands. `unknown_request` (404) when
   * the manager journalled no stamp operation under the id. Throws, asking nothing, for what is not a UUID.
   */
  async stampOperationStatus(requestId: string): Promise<FundingStampOperationStatus> {
    return this.#call('GET', fundingStampOperationPath(requestId), fundingStampOperationStatusSchema);
  }

  /**
   * `POST /api/admin-funding/chequebook-operations`: one deposit into or withdrawal from a node's chequebook, which the
   * manager checks, journals and asks the node for. Only the contract's fields go, so a request cannot name where a
   * withdrawal goes: Bee withdraws into the node's own wallet. The manager answers once the node has, so the call has a
   * deadline of its own, the longest ({@link MANAGER_FUNDING_CHEQUEBOOK_TIMEOUT_MS}). The same request id sent again
   * with the same fields answers the operation's state and never runs it twice, so a call that ended in `unreachable`
   * or `timeout` is made again as it was, once a status read says the manager never received it.
   */
  async chequebookOperation(operation: FundingChequebookOperationRequest): Promise<FundingChequebookOperationAnswer> {
    const { requestId, nodeId, direction, amountPlur } = operation;
    return this.#call(
      'POST',
      FUNDING_CHEQUEBOOK_OPERATIONS_PATH,
      fundingChequebookOperationAnswerSchema,
      { requestId, nodeId, direction, amountPlur },
      this.#chequebookTimeoutMs,
    );
  }

  /**
   * `GET /api/admin-funding/chequebook-operations/:requestId`: where a chequebook operation stands. `unknown_request`
   * (404) when the manager journalled no chequebook operation under the id. Throws, asking nothing, for what is not a
   * UUID.
   */
  async chequebookOperationStatus(requestId: string): Promise<FundingChequebookOperationStatus> {
    return this.#call('GET', fundingChequebookOperationPath(requestId), fundingChequebookOperationStatusSchema);
  }

  async #call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: AnswerSchema<T>,
    body?: object,
    timeoutMs: number = this.#timeoutMs,
  ): Promise<T> {
    const route = `${method} ${path}`;
    const deadline = AbortSignal.timeout(timeoutMs);
    // Aborted once the call is over, so a body left unread, such as a redirect's, does not hold the connection.
    const finished = new AbortController();
    const signal = AbortSignal.any([deadline, finished.signal]);
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    const init: RequestInit = { method, headers, redirect: 'manual', signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let status: number;
    let bytes: Buffer;
    try {
      const response = await this.#fetch(`${this.#base}${path}`, init);
      status = response.status;
      if (isRedirect(response)) {
        throw new ManagerFundingError(
          'bad_answer',
          status,
          `The manager answered ${route} with a redirect, which the admin does not follow: ${MANAGER_FUNDING_URL_KEY} has to be the address the manager answers on itself.`,
        );
      }
      bytes = await readAnswer(response, signal, this.#maxAnswerBytes, route);
    } catch (error) {
      if (error instanceof ManagerFundingError) throw error;
      const [code, message] = deadline.aborted
        ? (['timeout', `The manager did not answer ${route} within ${timeoutMs} ms.`] as const)
        : (['unreachable', `The manager could not be reached for ${route}.`] as const);
      throw new ManagerFundingError(code, null, message, { cause: error });
    } finally {
      finished.abort();
    }

    const notJson = `The manager answered ${route} with status ${status} and a body that is not JSON.`;
    let answer: unknown;
    try {
      answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ManagerFundingError('not_json', status, notJson);
    }

    if (status >= 200 && status < 300) {
      const parsed = schema.safeParse(answer);
      if (parsed.success) return parsed.data;
      throw new ManagerFundingError(
        'bad_answer',
        status,
        `The manager's answer to ${route} is not the funding API's: ${firstIssue(parsed.error)}.`,
      );
    }
    const refusal = fundingErrorAnswerSchema.safeParse(answer);
    if (refusal.success) throw new ManagerFundingError(refusal.data.error, status, refusal.data.message);
    throw new ManagerFundingError(
      'bad_answer',
      status,
      `The manager answered ${route} with status ${status} and no funding API error: is ${MANAGER_FUNDING_URL_KEY} the manager's address, and does it run the funding API?`,
    );
  }
}
