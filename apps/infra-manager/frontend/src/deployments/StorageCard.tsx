import { useState } from 'react';
import { Alert, Button, CircularProgress, Divider, Link, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  type ChequebookHealth,
  formatFillPercent,
  getErrorMessage,
  isStampExpiringSoon,
  isStampNearlyFull,
  nearlyFullConsequence,
  parsePlur,
  type StampHealth,
} from '@streaming-infra-manager/common';

import { routes } from '../app/router';
import { useDeployments } from '../app/useDeploymentsStore';
import { pinnedBatchNote } from '../catalogueNode/catalogueNodeView';
import { ConfirmDialog, type ConfirmRequest } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';
import { formatTtl, shortHex } from '../format';
import { ApiError } from '../http';
import type { Profile } from '../types';
import { BuyStampForm } from '../uploaders/BuyStampForm';
import { MoveBzzDialog, type MoveDirection } from '../uploaders/MoveBzzDialog';
import { NodeFunding } from '../uploaders/NodeFunding';
import { StampTable } from '../uploaders/StampTable';
import { DiluteStampDialog } from '../uploaders/DiluteStampDialog';
import { diluteSentNotice } from '../uploaders/diluteView';
import { type BeeStamp, buyStamp, diluteStamp, setStamp, topUpStamp, type BuyStampInput } from '../uploaders/stampApi';
import { TopUpStampDialog } from '../uploaders/TopUpStampDialog';
import { topUpSentNotice } from '../uploaders/topUpView';
import type { BeeUtils } from '../uploaders/useBeeUtils';
import { type BatchUploader, applyNow, batchNotice, setBatchAndReread } from './batchUploaders';
import { fetchIngestHealth } from './ingestHealthApi';
import { newBatchReach } from './newBatchReach';
import { applyDeploymentSettings } from './settings/deploymentSettingsApi';
import { appliedText, applyRefusalText } from './settings/settingsText';
import type { BatchUploadersLoad } from './useBatchUploaders';

/** A change to a batch the node holds, while its dialog is open. */
interface StampChange {
  kind: 'top-up' | 'dilute';
  stamp: BeeStamp;
}

/**
 * The deployment's own Bee node: what it holds, what it can still pay peers
 * with, which batches it has, and how to buy the next one, top one up or
 * dilute one.
 *
 * It takes the node data rather than fetching it, because the readiness
 * checklist above is derived from the same answer and the two must not disagree
 * about whether there is a usable stamp.
 */
export function StorageCard({
  profile,
  bee,
  stampHealth,
  chequebookHealth,
  defaultDepth,
  rung,
  catalogueBatchId = null,
  uploaders,
  onChanged,
}: {
  profile: Profile;
  bee: BeeUtils;
  stampHealth: StampHealth;
  chequebookHealth: ChequebookHealth | null;
  /** An ABR rung starts the buy form at the depth its bitrate wants. */
  defaultDepth?: number;
  /** The ABR rung this node publishes, when it is a pool member. */
  rung?: string | null;
  /** The batch pinned for the brand's catalogue, when this node is the catalogue node. */
  catalogueBatchId?: string | null;
  /** The stream uploaders that pay with this node's batches: the deployment's own, or the stages a rung feeds. */
  uploaders: BatchUploadersLoad;
  onChanged: () => void;
}) {
  const { chequebookFloorBzz } = useDeployments();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveDirection | null>(null);
  const [change, setChange] = useState<StampChange | null>(null);
  /** What bee answered the last change with, until the operator closes it. */
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // Every action goes through here and lands its failure in actionError, so a caller need not await it.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleBuy = (input: BuyStampInput) =>
    run(async () => {
      const { batchID } = await buyStamp(profile.name, input);
      bee.waitForStamp(batchID);
      await bee.reload();
    });

  const handleUse = (batchID: string) =>
    run(() =>
      setBatchAndReread(batchID, {
        setStamp: (id) => setStamp(profile.name, id),
        reloadDeployments: onChanged,
        rereadUploaders: uploaders.reread,
      }),
    );

  const handleApplyNow = (uploader: BatchUploader) =>
    run(() =>
      applyNow(uploader, {
        readIngest: (name) => fetchIngestHealth(name),
        confirm: (request) => setConfirm({ ...request, onConfirm: () => void run(request.onConfirm) }),
        apply: applyRefusedInWords,
        done: async (applied) => {
          const text = appliedText(applied);
          setSentNotice(uploader.own ? text : `${uploader.name}: ${text}`);
          await uploaders.reread();
        },
      }),
    );

  const openChange = (kind: StampChange['kind'], stamp: BeeStamp) => {
    setActionError(null);
    setChange({ kind, stamp });
  };

  const handleTopUp = (stamp: BeeStamp, amount: string) =>
    run(async () => {
      const sent = await topUpStamp(profile.name, { batch_id: stamp.batchID, amount });
      setChange(null);
      setSentNotice(topUpSentNotice(stamp, sent));
      await bee.reload();
    });

  const handleDilute = (stamp: BeeStamp, depth: number) =>
    run(async () => {
      const sent = await diluteStamp(profile.name, { batch_id: stamp.batchID, depth });
      setChange(null);
      setSentNotice(diluteSentNotice(stamp, depth, sent));
      await bee.reload();
    });

  const reach = newBatchReach(profile, rung);
  const notice = batchNotice(profile.stamp_id, uploaders.uploaders);
  const behind = uploaders.uploaders.filter((uploader) => uploader.behind);

  const nearlyFullAt =
    stampHealth.state === 'active' &&
    stampHealth.fillRatio !== null &&
    isStampNearlyFull(stampHealth.fillRatio, stampHealth.immutable)
      ? formatFillPercent(stampHealth.fillRatio)
      : null;

  const moveSourcePlur =
    moving === 'withdraw' ? parsePlur(bee.chequebook?.availableBalance) : parsePlur(bee.wallet?.bzzBalance);

  return (
    <SectionCard
      id="storage"
      title="Storage and funding"
      sub="this deployment's own Bee node pays for its uploads"
      actions={
        <Button size="small" startIcon={<RefreshIcon />} disabled={bee.loading} onClick={() => void bee.reload()}>
          Refresh
        </Button>
      }
    >
      <Stack spacing={2}>
        {catalogueBatchId && (
          <Alert severity="info" data-catalogue-note>
            {pinnedBatchNote(catalogueBatchId)}
          </Alert>
        )}
        {bee.loadError && <Alert severity="warning">{bee.loadError}</Alert>}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {sentNotice && (
          <Alert severity="info" onClose={() => setSentNotice(null)}>
            {sentNotice}
          </Alert>
        )}
        {notice && (
          <Alert severity="warning" data-batch-notice sx={{ '& .MuiAlert-message': { minWidth: 0 } }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {notice.lead}
            </Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>
              {notice.rows.map((row) => (
                <Stack
                  key={row.name}
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                >
                  {!row.own && (
                    <Link href={routes.deployment(row.name)} variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {row.name}
                    </Link>
                  )}
                  <Typography variant="body2">{row.what}</Typography>
                  <Button
                    variant="contained"
                    color="warning"
                    size="small"
                    disabled={busy}
                    onClick={() => {
                      const uploader = behind.find((candidate) => candidate.name === row.name);
                      if (uploader) void handleApplyNow(uploader);
                    }}
                  >
                    Apply now
                  </Button>
                </Stack>
              ))}
            </Stack>
          </Alert>
        )}
        {stampHealth.dead && (
          <Alert severity="error">
            {stampHealth.state === 'expired'
              ? 'The postage batch this deployment pays with has expired. '
              : 'This Bee node does not hold the batch recorded for it, usually because the batch expired and was dropped. '}
            Uploads cannot be paid for until a new batch is bought below, which is set here once it is usable.
          </Alert>
        )}
        {stampHealth.state === 'full' && (
          <Alert severity="error">
            The postage batch this deployment pays with is full, and it cannot overwrite what it holds, so this Bee node
            refuses the uploads it is sent. Dilute it below to give it room, which keeps the batch, or buy a new one,
            which is set here once it is usable.
          </Alert>
        )}
        {nearlyFullAt && (
          <Alert severity="warning">
            This batch is <strong>{nearlyFullAt} full</strong>.{' '}
            {nearlyFullConsequence(stampHealth.immutable, stampHealth.fillRatio)} Dilute it below, or buy the next one.
          </Alert>
        )}
        {!stampHealth.dead && stampHealth.state !== 'full' && isStampExpiringSoon(stampHealth.ttl) && (
          <Alert severity="warning">
            This batch runs out in <strong>{formatTtl(stampHealth.ttl)}</strong>. Top it up below, or buy the next one,
            before it does. Once a batch is spent its uploads fail and it cannot be revived.
          </Alert>
        )}
        {bee.waitingBatch && (
          <Alert severity="info" icon={<CircularProgress size={18} />}>
            Waiting for batch <code>{shortHex(bee.waitingBatch)}</code> to become usable. This takes a few minutes, and
            it is then set here automatically, unless another batch is set with <strong>Use</strong> first.
            {reach ? ` ${reach}` : ''}
          </Alert>
        )}

        <NodeFunding
          address={bee.address}
          wallet={bee.wallet}
          chequebook={bee.chequebook}
          chequebookHealth={chequebookHealth}
          loading={bee.loading}
          busy={busy}
          onFill={() => setMoving('fill')}
          onWithdraw={() => setMoving('withdraw')}
        />

        <Button sx={{ alignSelf: 'flex-start' }} onClick={() => setMoving('fill')}>
          Saved transfer
        </Button>

        <Divider />

        <StampTable
          stamps={bee.stamps}
          loading={bee.loading}
          currentStampId={profile.stamp_id}
          uploaders={uploaders.uploaders}
          pinnedBatchId={catalogueBatchId}
          busy={busy}
          onUse={(batchID) => void handleUse(batchID)}
          onTopUp={(stamp) => openChange('top-up', stamp)}
          onDilute={(stamp) => openChange('dilute', stamp)}
        />

        <Divider />

        <BuyStampForm
          busy={busy}
          onBuy={handleBuy}
          currentPrice={bee.chainState?.currentPrice ?? null}
          defaultDepth={defaultDepth}
          newBatchReach={reach}
        />
      </Stack>

      <MoveBzzDialog
        open={moving !== null}
        direction={moving ?? 'fill'}
        sourcePlur={moveSourcePlur}
        floorBzz={chequebookFloorBzz}
        profileName={profile.name}
        profileInstanceId={profile.instance_id}
        onClose={() => setMoving(null)}
      />

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

      {change?.kind === 'top-up' && (
        <TopUpStampDialog
          key={change.stamp.batchID}
          stamp={change.stamp}
          currentPrice={bee.chainState?.currentPrice ?? null}
          walletBzz={bee.wallet?.bzzBalance ?? null}
          busy={busy}
          error={actionError}
          onConfirm={(amount) => void handleTopUp(change.stamp, amount)}
          onClose={() => setChange(null)}
        />
      )}
      {change?.kind === 'dilute' && (
        <DiluteStampDialog
          key={change.stamp.batchID}
          stamp={change.stamp}
          busy={busy}
          error={actionError}
          onConfirm={(depth) => void handleDilute(change.stamp, depth)}
          onClose={() => setChange(null)}
        />
      )}
    </SectionCard>
  );
}

/** The settings list's Apply, with a refusal put the way the Stack settings card puts it. */
async function applyRefusedInWords(name: string, instanceId: string) {
  try {
    return await applyDeploymentSettings(name, instanceId);
  } catch (caught) {
    if (caught instanceof ApiError) throw new Error(applyRefusalText(caught.code, caught.message), { cause: caught });
    throw caught;
  }
}
