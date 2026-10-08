import {
  FUNDING_KIND_DECIMALS,
  sumBaseUnits,
  type AdminFundingNode,
  type FundingTransferKind,
  type FundingView,
} from '@streaming-monorepo/web2-admin-common';

import { formatUnits, readAmount } from './amounts';

/** Gnosis Chain's block explorer, where a transfer is looked up by its hash. The one place the page names it. */
export const EXPLORER_TX_URL = 'https://gnosis.blockscout.com/tx/';

export function txUrl(hash: string): string {
  return `${EXPLORER_TX_URL}${hash}`;
}

export interface NodeGroup {
  key: string;
  title: string;
  catalogue: boolean;
  nodes: AdminFundingNode[];
}

type Inventory = Pick<FundingView, 'stages' | 'catalogue'>;

/** The catalogue node in a group of its own on top, then each stage's nodes under its name, in the admin's order. */
export function nodeGroups(view: Inventory): NodeGroup[] {
  const groups: NodeGroup[] = view.catalogue
    ? [{ key: 'catalogue', title: 'Catalogue node', catalogue: true, nodes: [view.catalogue] }]
    : [];
  for (const stage of view.stages) {
    groups.push({ key: `stage:${stage.stageId}`, title: stage.name, catalogue: false, nodes: stage.nodes });
  }
  return groups;
}

/**
 * A node's name on one line: its label without the stage name the manager starts it with, such as `360p rung,
 * dev-stage-1-360p` out of `dev-stage-1-uploader 360p rung, dev-stage-1-360p`, since the line under it names the
 * stage. A label that does not start with it, the catalogue node's among them, is the name as it is.
 */
export function nodeName(node: AdminFundingNode, group: NodeGroup): string {
  const prefix = `${group.title} `;
  return !group.catalogue && node.label.startsWith(prefix) && node.label.length > prefix.length
    ? node.label.slice(prefix.length)
    : node.label;
}

/** The line under a node's name: its stage and its role, or its role alone for the catalogue node. */
export function nodeCaption(node: AdminFundingNode, group: NodeGroup): string {
  return group.catalogue ? node.role : `${group.title} · ${node.role}`;
}

/**
 * Every node once, in the order the page lists them. A node pool shared by two stages is listed under both with one
 * nodeId, so it is ticked, confirmed, counted and sent once.
 */
export function allNodes(view: Inventory): AdminFundingNode[] {
  const byId = new Map<string, AdminFundingNode>();
  for (const node of nodeGroups(view).flatMap((group) => group.nodes)) {
    if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  }
  return [...byId.values()];
}

/** The nodes whose wallet address the operator has yet to confirm: new ones and changed ones the manager could read. */
export function unconfirmedNodes(view: Inventory): AdminFundingNode[] {
  return allNodes(view).filter((node) => node.walletAddress !== null && node.pin !== 'pinned');
}

/** What the operator entered for one node: whether it is ticked, and the two amounts as typed. */
export interface NodeDraft {
  ticked: boolean;
  xdai: string;
  xbzz: string;
}

export type Drafts = Readonly<Record<string, NodeDraft>>;

/**
 * What the Balance tab opens with when the Stamps tab's Fund link sends it a node: that node ticked, with the xBZZ the
 * link names typed in, every digit of it, and no xDAI.
 */
export function fundDrafts(nodeId: string, xbzzPlur: string): Drafts {
  return { [nodeId]: { ticked: true, xdai: '', xbzz: formatUnits(xbzzPlur, FUNDING_KIND_DECIMALS.xbzz) } };
}

/** One transfer Send would ask for: an amount of one kind, in base units, to one node. */
export interface TransferLine {
  nodeId: string;
  label: string;
  kind: FundingTransferKind;
  amount: string;
}

export interface SendCheck {
  lines: TransferLine[];
  /** What the lines add up to, per kind, in base units. */
  totals: Record<FundingTransferKind, string>;
  over: Record<FundingTransferKind, boolean>;
  /** Why Send cannot send, in the order the page says them; empty when it can. */
  problems: string[];
}

export const TOKENS: Readonly<Record<FundingTransferKind, { name: string; decimals: number }>> = {
  xdai: { name: 'xDAI', decimals: FUNDING_KIND_DECIMALS.xdai },
  xbzz: { name: 'xBZZ', decimals: FUNDING_KIND_DECIMALS.xbzz },
};

const KINDS: readonly FundingTransferKind[] = ['xdai', 'xbzz'];

/**
 * The transfers the ticked nodes ask for, their totals against the brand wallet's balances, and every reason Send
 * cannot send them: an amount it cannot read, a node whose address is not confirmed, nothing to send, no wallet, a
 * balance it could not read, or a total over the balance. A zero or empty amount sends nothing.
 */
export function checkSend(view: Pick<FundingView, 'wallet' | 'stages' | 'catalogue'>, drafts: Drafts): SendCheck {
  const lines: TransferLine[] = [];
  const problems: string[] = [];
  for (const node of allNodes(view)) {
    const draft = drafts[node.nodeId];
    if (!draft?.ticked) continue;
    let sends = false;
    for (const kind of KINDS) {
      const read = readAmount(draft[kind], TOKENS[kind].decimals);
      if (read.kind === 'invalid') {
        problems.push(`The ${TOKENS[kind].name} amount for ${node.label}: ${read.problem}`);
      } else if (read.kind === 'ok' && read.value !== '0') {
        lines.push({ nodeId: node.nodeId, label: node.label, kind, amount: read.value });
        sends = true;
      }
    }
    if (sends && (node.walletAddress === null || node.pin !== 'pinned')) {
      problems.push(`Confirm the address of ${node.label} before sending to it.`);
    }
  }

  const sum = (kind: FundingTransferKind) =>
    sumBaseUnits(lines.filter((line) => line.kind === kind).map((line) => line.amount));
  const totals = { xdai: sum('xdai'), xbzz: sum('xbzz') };
  const over = { xdai: false, xbzz: false };

  if (lines.length === 0 && problems.length === 0) problems.push('Enter an amount beside a node to send it.');
  if (lines.length > 0) {
    const wallet = view.wallet;
    if (!wallet) {
      problems.push('There is no brand wallet to send from.');
    } else {
      for (const kind of KINDS) {
        if (totals[kind] === '0') continue;
        const balance = kind === 'xdai' ? wallet.xdaiWei : wallet.xbzzPlur;
        if (balance === null || !/^\d+$/.test(balance)) {
          problems.push(`The brand wallet's ${TOKENS[kind].name} balance could not be read.`);
        } else if (BigInt(totals[kind]) > BigInt(balance)) {
          over[kind] = true;
          problems.push(`That is more ${TOKENS[kind].name} than the brand wallet holds.`);
        }
      }
    }
  }

  return { lines, totals, over, problems };
}
