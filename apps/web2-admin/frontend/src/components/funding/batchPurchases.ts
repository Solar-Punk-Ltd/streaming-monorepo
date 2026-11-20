import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BATCH_PURCHASE_OPEN_STATES,
  batchOffersPurchase,
  batchPurchasePurpose,
  XBZZ_DECIMALS,
  type AdminFundingNode,
  type BatchPurchase,
  type BuyablePurpose,
} from '@streaming-monorepo/web2-admin-common';

import * as api from '../../api';
import { errorMessage } from '../../errors';
import { formatShort } from './amounts';
import { dayCount } from './stamps';

/**
 * Buy new on the Stamps tab: which rows offer it, where a purchase stands in words, and the purchases as the tab reads
 * them. `docs/architecture/funding.md`, "Buying a new batch", is the design; the common `batchPurchase.ts` is the
 * contract.
 */

/** How often the tab reads the purchases again while one is under way. */
export const BATCH_PURCHASE_POLL_MS = 10_000;

/** Said in a row while a purchase on its node is under way, in place of Buy new. */
export const PURCHASE_UNDER_WAY = 'A new batch is being bought for this node.';

/** Said in a row whose last purchase stopped after its batch was bought: Check again takes it up, and buys nothing. */
export const PURCHASE_TO_CHECK = 'Its new batch is bought. Check again below puts it to use.';

/** Said under a stopped purchase whose bought batch has run out since: no check can put it to use. */
export const BOUGHT_BATCH_RAN_OUT = 'Its bought batch is no longer on the node, so a new one can be bought.';

/** Said in a row with no batch at all, where Buy new buys the first. */
export const NO_BATCH_SET = 'No batch is set on this node.';

/** Said when the purchases could not be read, with why. */
export function purchasesReadFailed(error: string): string {
  return `The batch purchases could not be read: ${error}`;
}

/** Whether a purchase is still under way: bought, waiting, being put to use. */
export function purchaseOpen(purchase: Pick<BatchPurchase, 'state'>): boolean {
  return BATCH_PURCHASE_OPEN_STATES.includes(purchase.state);
}

/** The latest purchase of each node, by when it was started. */
export function latestPurchases(purchases: readonly BatchPurchase[]): ReadonlyMap<string, BatchPurchase> {
  const latest = new Map<string, BatchPurchase>();
  for (const purchase of purchases) {
    const kept = latest.get(purchase.nodeId);
    if (!kept || purchase.startedAt > kept.startedAt) latest.set(purchase.nodeId, purchase);
  }
  return latest;
}

/** Where a purchase stands, in a sentence. */
export function purchaseStateText(purchase: BatchPurchase): string {
  switch (purchase.state) {
    case 'buying':
      return 'Being bought. The node pays once its transaction is mined.';
    case 'waiting_usable':
      return 'Bought, and waiting for the network: the node can stamp with it in a few minutes.';
    case 'restarting':
      return 'Set on the rung. The uploaders that follow it are restarted one stage at a time.';
    case 'moving':
      return 'Designated as the catalogue batch. The catalogue is being moved onto it.';
    case 'done':
      return purchase.purpose === 'catalogue'
        ? 'The catalogue is written with the new batch.'
        : 'The new batch pays for uploads on every stage that takes it.';
    case 'failed':
      return `Stopped: ${purchase.error ?? 'the purchase did not go through.'}`;
  }
}

/** What was bought, in a line: depth, kind, days and cost. */
export function purchaseWhat(purchase: BatchPurchase): string {
  const kind = purchase.immutable ? 'immutable' : 'mutable';
  return `New batch: depth ${purchase.depth}, ${kind}, ${dayCount(purchase.days)}, ${formatShort(purchase.costPlur, XBZZ_DECIMALS)} xBZZ.`;
}

/** What a row offers a purchase with: the node, the purpose, and the batch it replaces, or null for none. */
export interface BuyOffer {
  node: AdminFundingNode;
  purpose: BuyablePurpose;
  replacesBatchId: string | null;
}

/**
 * The Buy new a node's row offers, or null: the common `batchOffersPurchase` says the node's batch no longer pays and
 * the manager recommends a replacement. `catalogueNodeId` is the catalogue node's, whose purchase is for the catalogue.
 */
export function buyOfferOf(node: AdminFundingNode, catalogueNodeId: string | null): BuyOffer | null {
  if (!batchOffersPurchase(node)) return null;
  return {
    node,
    purpose: batchPurchasePurpose(node.nodeId === catalogueNodeId),
    replacesBatchId: node.batch?.batchId ?? null,
  };
}

export interface BatchPurchasesRead {
  purchases: BatchPurchase[] | null;
  error: string | null;
  /** Reads the purchases again now. */
  reload: () => void;
}

/**
 * The batch purchases as the admin answers them, read when `version` changes, which is each time the tab reads the
 * Funding view, and again every {@link BATCH_PURCHASE_POLL_MS} while one is under way. `onSettled` is called once
 * fewer are under way than at the read before, so the tab reads the view again and the row shows the new batch.
 */
export function useBatchPurchases(version: unknown, onSettled: () => void): BatchPurchasesRead {
  const [purchases, setPurchases] = useState<BatchPurchase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const open = useRef<number | null>(null);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);

  const read = useCallback(async (background: boolean) => {
    try {
      const next = await api.fetchBatchPurchases({ background });
      const now = next.purchases.filter(purchaseOpen).length;
      const before = open.current;
      open.current = now;
      setPurchases(next.purchases);
      setError(null);
      if (before !== null && now < before) settled.current();
    } catch (e: unknown) {
      setError(errorMessage(e, 'The batch purchases could not be read.'));
    }
  }, []);

  useEffect(() => {
    void read(false);
  }, [read, version, tick]);

  const anyOpen = purchases?.some(purchaseOpen) ?? false;
  useEffect(() => {
    if (!anyOpen) return undefined;
    const timer = setInterval(() => void read(true), BATCH_PURCHASE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, read]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { purchases, error, reload };
}
