import type { FundingBatch, FundingInventory, FundingNode } from '@streaming-monorepo/contracts';
import {
  AUTO_TOPUP_DEFAULTS,
  type AutoTopUpComing,
  type AutoTopUpJob,
  type AutoTopUpMarkItem,
  type AutoTopUpSettings,
  type AutoTopUpStampState,
  type AutoTopUpView,
  autoTopUpDailyCeilingPlur,
  autoTopUpMonthlyEstimatePlur,
  autoTopUpSettingsProblems,
  autoTopUpStampPlan,
  operableBatch,
  SECONDS_PER_DAY,
} from '@streaming-monorepo/web2-admin-common';

import { getErrorMessage } from '../../utils/errorUtils.js';
import { describeActor, type OperatorActor } from '../actor.js';
import { recordAudit, type AuditLog } from '../AuditLog.js';
import { FundingManagerUnavailableError, FundingRefusedError, RequestShapeError } from '../errors/index.js';
import { AutoTopUpNotMarkableError } from '../errors/AutoTopUpNotMarkableError.js';
import { Logger } from '../Logger.js';
import { notificationChannelStatuses, type NotificationStatusSource } from '../notifications/channelStatus.js';

import { ADMIN_FUNDING_CHAIN_ID, managerProblem } from './FundingService.js';
import type { ManagerFundingClient } from './ManagerFundingClient.js';
import type {
  AutoTopUpMarkRow,
  AutoTopUpSettingsRow,
  NewAutoTopUpMark,
  StampAutoTopUpStore,
} from './StampAutoTopUpStore.js';

const logger = Logger.getInstance();

/** What the view reads of the manager: its inventory, the nodes, their batches and the price of postage. */
export type AutoTopUpManager = Pick<ManagerFundingClient, 'inventory'>;

export interface StampAutoTopUpServiceDeps {
  store: StampAutoTopUpStore;
  /** The manager's funding API, or null without MANAGER_API_URL and MANAGER_API_TOKEN. */
  manager: AutoTopUpManager | null;
  audit: AuditLog;
  /** The admin's notification channels, whose status the view shows. */
  notifications: NotificationStatusSource;
  now?: () => number;
}

/** The settings as the view answers them, from the saved row. */
function settingsOf(row: AutoTopUpSettingsRow): AutoTopUpSettings {
  return {
    topUpUnderDays: row.topUpUnderDays,
    topUpToDays: row.topUpToDays,
    lookAheadDays: row.lookAheadDays,
    marginPercent: row.marginPercent,
    xdaiWarningWei: row.xdaiWarningWei,
    dailyCeilingPlur: row.dailyCeilingPlur,
  };
}

/** The nodes a stamp may be held by and paid for from: each stage's nodes and the designated catalogue node. */
function fundedNodes(inventory: FundingInventory): FundingNode[] {
  return [...inventory.stages.flatMap((stage) => stage.nodes), ...(inventory.catalogue ? [inventory.catalogue] : [])];
}

/** The batch as the inventory reads it now: a funded node's own, or an archive stamp, or null when it lists none. */
function batchListed(inventory: FundingInventory, batchId: string): FundingBatch | null {
  for (const node of fundedNodes(inventory)) {
    if (node.batch?.batchId === batchId) return node.batch;
  }
  return (inventory.archiveBatches ?? []).find((archive) => archive.batchId === batchId) ?? null;
}

/**
 * The stamp to mark for an item, or why it cannot be marked, in a sentence. A stamp is marked when the admin could top
 * it up now: a batch a stage's node or the catalogue node uploads with, or an archive stamp such a node holds, read
 * whole, usable and not expired (`operableBatch`). The node's label is the inventory's now.
 */
export function markableOf(item: AutoTopUpMarkItem, inventory: FundingInventory): NewAutoTopUpMark | string {
  const short = `${item.batchId.slice(0, 10)}…`;
  const nodes = fundedNodes(inventory).filter((node) => node.nodeId === item.nodeId);
  if (nodes.length === 0)
    return `The manager lists no node ${item.nodeId} the admin funds, so batch ${short} is not marked.`;
  const own = nodes.find((node) => node.batch?.batchId === item.batchId);
  const archive = (inventory.archiveBatches ?? []).find(
    (held) => held.nodeId === item.nodeId && held.batchId === item.batchId,
  );
  const batch = own?.batch ?? archive ?? null;
  if (!batch) {
    return `Batch ${short} is not a batch ${nodes[0]!.label} uploads with or holds as an archive stamp, so it is not marked.`;
  }
  if (!operableBatch(batch)) {
    return `Batch ${short} cannot be topped up now: it could not be read, is not usable or has expired. It is not marked.`;
  }
  return { batchId: item.batchId, nodeId: item.nodeId, nodeLabel: own?.label ?? archive!.nodeLabel };
}

/**
 * Stamp auto top-up's settings view and its three writes: the numbers, the marks and each job's pause.
 * The jobs themselves run in the tick. Every write is audited with the operator's name and answers the whole view.
 */
export class StampAutoTopUpService {
  private readonly store: StampAutoTopUpStore;
  private readonly manager: AutoTopUpManager | null;
  private readonly audit: AuditLog;
  private readonly notifications: NotificationStatusSource;
  private readonly now: () => number;

  constructor(deps: StampAutoTopUpServiceDeps) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.audit = deps.audit;
    this.notifications = deps.notifications;
    this.now = deps.now ?? Date.now;
  }

  /**
   * `GET /api/funding/auto-top-up`. The stamps' plans, the monthly estimate and the daily ceiling are read from the
   * manager's inventory now; without one, or without a price of postage, the estimate and the ceiling are null and no
   * stamp shows a coming top-up, while its alert stays recorded. The channels' status is the notification store's.
   */
  async view(): Promise<AutoTopUpView> {
    const now = this.now();
    const [saved, jobs, notifications, marks, warnings, sends] = await Promise.all([
      this.store.settings(),
      this.store.jobs(),
      notificationChannelStatuses(this.notifications),
      this.store.marks(),
      this.store.warnings(),
      this.store.systemSendsSince(new Date(now - SECONDS_PER_DAY * 1000)),
    ]);
    const settings = saved ? settingsOf(saved) : AUTO_TOPUP_DEFAULTS;
    const inventory = await this.readInventoryForView();
    const postage = inventory?.chain.postage ?? null;
    const lastTopUps = new Map(
      (await this.store.lastSystemTopUps(marks.map((mark) => mark.batchId))).map((topUp) => [topUp.batchId, topUp]),
    );

    const depths: number[] = [];
    const stamps = marks.map((mark): AutoTopUpStampState => {
      const batch = inventory ? batchListed(inventory, mark.batchId) : null;
      const readable = operableBatch(batch) ? batch : null;
      if (readable) depths.push(readable.depth);
      const lastTopUp = lastTopUps.get(mark.batchId);
      const problem =
        warnings.find((warning) => warning.batchId === mark.batchId && warning.kind === 'stamp_expired') ??
        warnings.find((warning) => warning.batchId === mark.batchId && warning.kind === 'topup_failed');
      return {
        batchId: mark.batchId,
        nodeId: mark.nodeId,
        nodeLabel: mark.nodeLabel,
        markedBy: mark.markedBy,
        markedAt: mark.markedAt.toISOString(),
        lastTopUp: lastTopUp
          ? { at: lastTopUp.at.toISOString(), days: lastTopUp.days, costPlur: lastTopUp.costPlur }
          : null,
        coming:
          readable && postage ? comingOf(mark, autoTopUpStampPlan(readable, settings, postage), settings, now) : null,
        problem: problem?.message ?? null,
      };
    });
    const monthlyEstimatePlur = inventory && postage ? autoTopUpMonthlyEstimatePlur(depths, postage) : null;

    return {
      settings,
      settingsSavedBy: saved?.updatedBy ?? null,
      settingsSavedAt: saved?.updatedAt.toISOString() ?? null,
      jobs: jobs.map((job) => ({
        job: job.job,
        paused: job.paused,
        pausedBy: job.pausedBy,
        pausedAt: job.pausedAt?.toISOString() ?? null,
        lastRunAt: job.lastRunAt?.toISOString() ?? null,
        lastOk: job.lastOk,
        lastOutcome: job.lastOutcome,
      })),
      notifications,
      stamps,
      monthlyEstimatePlur,
      dailyCeilingPlur: monthlyEstimatePlur === null ? null : autoTopUpDailyCeilingPlur(settings, monthlyEstimatePlur),
      sentTodayPlur: sends.xbzzPlur,
      warnings: warnings.map((warning) => ({
        kind: warning.kind,
        batchId: warning.batchId,
        since: warning.since.toISOString(),
        message: warning.message,
        notifiedAt: warning.notifiedAt?.toISOString() ?? null,
      })),
    };
  }

  /** `PUT .../settings`, once the operator's password passed: saves the numbers `autoTopUpSettingsProblems` passes. */
  async saveSettings(actor: OperatorActor, settings: AutoTopUpSettings): Promise<AutoTopUpView> {
    const problems = autoTopUpSettingsProblems(settings);
    if (problems.length > 0) throw new RequestShapeError(problems);
    const saved: AutoTopUpSettings = {
      topUpUnderDays: settings.topUpUnderDays,
      topUpToDays: settings.topUpToDays,
      lookAheadDays: settings.lookAheadDays,
      marginPercent: settings.marginPercent,
      xdaiWarningWei: settings.xdaiWarningWei,
      dailyCeilingPlur: settings.dailyCeilingPlur,
    };
    await this.store.saveSettings(saved, actor.username, new Date(this.now()));
    logger.info(`[AutoTopUp] ${describeActor(actor)} saved the settings: ${JSON.stringify(saved)}`);
    await recordAudit(this.audit, { actor, action: 'funding.auto_topup.settings', details: { settings: saved } });
    return this.view();
  }

  /**
   * `PUT .../marks`: marks the stamps the admin could top up now, read from the manager's inventory, or takes the mark
   * off stamps, each with its alert and warnings. One stamp that cannot be marked refuses the request, and nothing is
   * marked. An unmark asks the manager nothing.
   */
  async setMarks(actor: OperatorActor, marked: boolean, items: readonly AutoTopUpMarkItem[]): Promise<AutoTopUpView> {
    const batchIds = [...new Set(items.map((item) => item.batchId))];
    if (!marked) {
      await this.store.unmark(batchIds);
      logger.info(`[AutoTopUp] ${describeActor(actor)} took the mark off ${batchIds.join(', ')}`);
      await recordAudit(this.audit, { actor, action: 'funding.auto_topup.unmark', details: { batchIds } });
      return this.view();
    }

    const inventory = await this.readInventoryForMarks();
    const toMark: NewAutoTopUpMark[] = [];
    const problems: string[] = [];
    for (const item of items) {
      if (toMark.some((mark) => mark.batchId === item.batchId)) continue;
      const markable = markableOf(item, inventory);
      if (typeof markable === 'string') problems.push(markable);
      else toMark.push(markable);
    }
    if (problems.length > 0) throw new AutoTopUpNotMarkableError(problems);

    await this.store.mark(toMark, actor.username, new Date(this.now()));
    logger.info(
      `[AutoTopUp] ${describeActor(actor)} marked ${toMark.map((mark) => `${mark.batchId} on ${mark.nodeId}`).join(', ')}`,
    );
    await recordAudit(this.audit, {
      actor,
      action: 'funding.auto_topup.mark',
      details: { stamps: toMark.map((mark) => ({ batchId: mark.batchId, nodeId: mark.nodeId })) },
    });
    return this.view();
  }

  /** `PUT .../jobs/:job`: pauses the job, or lets it run again. */
  async setJobPaused(actor: OperatorActor, job: AutoTopUpJob, paused: boolean): Promise<AutoTopUpView> {
    await this.store.setPaused(job, paused, actor.username, new Date(this.now()));
    logger.info(`[AutoTopUp] ${describeActor(actor)} ${paused ? 'paused' : 'resumed'} the ${job} job`);
    await recordAudit(this.audit, { actor, action: 'funding.auto_topup.job', details: { job, paused } });
    return this.view();
  }

  /** The inventory for the view, or null when funding is not set up, the manager could not be read, or is elsewhere. */
  private async readInventoryForView(): Promise<FundingInventory | null> {
    if (!this.manager) return null;
    try {
      const inventory = await this.manager.inventory();
      return inventory.chain.chainId === ADMIN_FUNDING_CHAIN_ID ? inventory : null;
    } catch (error) {
      logger.warn(`[AutoTopUp] could not read the manager for the view: ${getErrorMessage(error)}`);
      return null;
    }
  }

  /** The inventory a mark is checked against, read fresh; a manager that cannot be read refuses the mark. */
  private async readInventoryForMarks(): Promise<FundingInventory> {
    if (!this.manager) {
      throw new FundingRefusedError(
        'not_set_up',
        'Funding is not set up: the admin has no MANAGER_API_URL and MANAGER_API_TOKEN. Nothing was marked.',
      );
    }
    let inventory: FundingInventory;
    try {
      inventory = await this.manager.inventory();
    } catch (error) {
      logger.warn(`[AutoTopUp] could not read the manager's inventory: ${getErrorMessage(error)}`);
      throw new FundingManagerUnavailableError(`${managerProblem(error)} Nothing was marked.`);
    }
    if (inventory.chain.chainId !== ADMIN_FUNDING_CHAIN_ID) {
      throw new FundingManagerUnavailableError(
        `The manager reads chain ${inventory.chain.chainId}, not Gnosis Chain. Nothing was marked.`,
      );
    }
    return inventory;
  }
}

/**
 * The top-up coming for a marked stamp, from its recorded alert and its plan at today's price, or null while no alert
 * is recorded. The figures are the alert's, which the wallet job sends by; `due` and `dueAt` are the plan's now.
 * `sendAt` is the end of the alert's wait, while something is sent for it and the alert was given.
 */
function comingOf(
  mark: AutoTopUpMarkRow,
  plan: ReturnType<typeof autoTopUpStampPlan>,
  settings: AutoTopUpSettings,
  now: number,
): AutoTopUpComing | null {
  const { alert } = mark;
  if (!alert) return null;
  const sends = BigInt(alert.sendPlur) > 0n || alert.gasSend;
  return {
    due: plan.phase === 'due',
    dueAt: new Date(now + plan.dueInSeconds * 1000).toISOString(),
    days: alert.days,
    costPlur: alert.costPlur,
    costWithMarginPlur: alert.costWithMarginPlur,
    sendPlur: alert.sendPlur,
    gasSend: alert.gasSend,
    alertedAt: alert.alertedAt?.toISOString() ?? null,
    sendAt:
      sends && alert.alertedAt
        ? new Date(alert.alertedAt.getTime() + settings.lookAheadDays * SECONDS_PER_DAY * 1000).toISOString()
        : null,
  };
}
