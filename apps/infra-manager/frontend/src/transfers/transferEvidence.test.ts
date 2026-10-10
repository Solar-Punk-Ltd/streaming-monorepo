/**
 * What the page will accept as a manager record.
 *
 * The poll deadline decides whether the page keeps re-reading, so a value it
 * cannot read as a time is worse than no value at all: it would either promise
 * checking that is over or hide checking that is still running. Only null or a
 * real timestamp passes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chequebookAssertionConfirmation, CHEQUEBOOK_PREFLIGHT_REFUSALS } from '@streaming-infra-manager/common';
import {
  isCompleteTransferDetail,
  isTransferOperation,
  permitsNewTransfer,
  transferHeadline,
} from './transferEvidence';
import { isExactTransfer, type LinkedOperation, type StoredTransferIntent } from './transferIntentStore';

const operation = {
  id: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  profileName: 'synthetic-test',
  profileInstanceId: '33333333-3333-4333-8333-333333333333',
  requestedBy: 'user:7',
  direction: 'deposit',
  amountPlur: '5000000000000000',
  state: 'submitted',
  chainId: 100,
  nodeAddress: `0x${'11'.repeat(20)}`,
  chequebookAddress: `0x${'22'.repeat(20)}`,
  tokenAddress: `0x${'33'.repeat(20)}`,
  startBlockNumber: '500',
  startBlockHash: `0x${'44'.repeat(32)}`,
  nonceLowerBound: '9',
  nonceQueryTag: '0x1f4',
  transactionHash: `0x${'55'.repeat(32)}`,
  failureReason: null,
  revision: '0',
  dispatchStartedAt: '2026-09-08T00:00:00.000Z',
  receiptObservation: null,
  receiptCheckedAt: null,
  receiptPollUntil: '2026-09-10T14:32:00.000Z',
  recoveryObservation: null,
  recoveryCheckedAt: null,
  assertion: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
};

describe('isTransferOperation', () => {
  it('accepts a timestamp or null for the poll deadline', () => {
    assert.equal(isTransferOperation(operation), true);
    assert.equal(isTransferOperation({ ...operation, receiptPollUntil: null }), true);
  });

  it('refuses a poll deadline that is missing or is not a time', () => {
    const { receiptPollUntil: _absent, ...without } = operation;
    assert.equal(isTransferOperation(without), false);
    for (const value of ['soon', '', 0, 1_760_000_000_000, false, {}, []]) {
      assert.equal(
        isTransferOperation({ ...operation, receiptPollUntil: value }),
        false,
        `${JSON.stringify(value)} is not a poll deadline`,
      );
    }
  });

  it('refuses anything but the timestamp shape the manager writes', () => {
    for (const value of [
      '2026',
      '2026-09',
      '2026-09-10',
      'September 10 2026',
      '2026-09-10 14:32:00Z',
      '2026-09-10T14:32:00',
    ]) {
      assert.equal(
        isTransferOperation({ ...operation, receiptPollUntil: value }),
        false,
        `${JSON.stringify(value)} is not a poll deadline`,
      );
    }
    for (const value of [
      '2026-09-10T14:32:00Z',
      '2026-09-10T14:32:00.000Z',
      '2026-09-10T14:32:00.000000Z',
      '2026-09-10T16:32:00.000+02:00',
    ]) {
      assert.equal(
        isTransferOperation({ ...operation, receiptPollUntil: value }),
        true,
        `${JSON.stringify(value)} is a poll deadline`,
      );
    }
  });
});

describe('a transfer the preflight refused', () => {
  const refused = (failureReason: string) => ({
    operation: {
      ...operation,
      state: 'rejected',
      transactionHash: null,
      dispatchStartedAt: null,
      receiptPollUntil: null,
      failureReason,
    },
    responseEvidence: [],
    assertionConfirmation: chequebookAssertionConfirmation(operation.amountPlur),
  });

  it('is a complete record that allows a new transfer, whichever reason the preflight gave', () => {
    for (const reason of CHEQUEBOOK_PREFLIGHT_REFUSALS) {
      const detail = refused(reason);
      assert.equal(isCompleteTransferDetail(detail), true, reason);
      assert.equal(permitsNewTransfer(detail as never), true, reason);
      assert.equal(transferHeadline(detail as never), 'Transfer refused before submission', reason);
    }
  });

  it('is not a record when the reason is not one the manager writes', () => {
    assert.equal(isCompleteTransferDetail(refused('preflight_ran_out_of_luck')), false);
  });
});

describe('a transfer the web2 admin’s funding API requested', () => {
  const linked: LinkedOperation = {
    id: operation.id,
    requestId: operation.requestId,
    profileName: operation.profileName,
    profileInstanceId: operation.profileInstanceId,
    requestedBy: operation.requestedBy,
    direction: 'deposit',
    amountPlur: operation.amountPlur,
    chainId: operation.chainId,
    nodeAddress: operation.nodeAddress,
    chequebookAddress: operation.chequebookAddress,
    tokenAddress: operation.tokenAddress,
  };
  /** What this browser saved for the signed-in operator, user 7, under the same request id. */
  const intent: StoredTransferIntent = {
    requestId: operation.requestId,
    accountId: 7,
    profileName: operation.profileName,
    profileInstanceId: operation.profileInstanceId,
    direction: 'deposit',
    amountPlur: operation.amountPlur,
    createdAt: operation.createdAt,
  };

  it('is a manager record the history and the detail page show, requester and all', () => {
    assert.equal(isTransferOperation({ ...operation, requestedBy: 'web2-admin' }), true);
  });

  it('is never taken for the signed-in operator’s own, which only a user:<id> requester can be', () => {
    assert.equal(isExactTransfer(intent, linked), true, 'the same transfer recorded as user:7 is theirs');
    assert.equal(isExactTransfer(intent, { ...linked, requestedBy: 'web2-admin' }), false);
  });
});
