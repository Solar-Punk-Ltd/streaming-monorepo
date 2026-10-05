import { Pool } from 'pg';

/** One row of `funding_node_pins`, migration 017: the wallet an operator confirmed for a node. */
export interface FundingPinRow {
  nodeId: string;
  /** 0x and 40 hex digits, in lower case. */
  walletAddress: string;
  pinnedAt: Date;
  pinnedBy: string;
}

/** A pin to write: a node and the address confirmed for it. */
export interface NewFundingPin {
  nodeId: string;
  walletAddress: string;
}

/** Where the confirmed node wallets are kept: Postgres, or memory in the unit tests. */
export interface FundingPinStore {
  /** Every pin, by node id. */
  all(): Promise<Map<string, FundingPinRow>>;
  /** Pins each node's address, replacing the one it had, all of them or none. */
  pin(pins: readonly NewFundingPin[], pinnedBy: string): Promise<void>;
}

interface Row {
  node_id: string;
  wallet_address: string;
  pinned_at: Date;
  pinned_by: string;
}

/** The pins, migration 017. */
export class FundingPinRepository implements FundingPinStore {
  constructor(private readonly pool: Pool) {}

  async all(): Promise<Map<string, FundingPinRow>> {
    const result = await this.pool.query<Row>(
      'SELECT node_id, wallet_address, pinned_at, pinned_by FROM funding_node_pins',
    );
    return new Map(
      result.rows.map((row) => [
        row.node_id,
        { nodeId: row.node_id, walletAddress: row.wallet_address, pinnedAt: row.pinned_at, pinnedBy: row.pinned_by },
      ]),
    );
  }

  async pin(pins: readonly NewFundingPin[], pinnedBy: string): Promise<void> {
    if (pins.length === 0) return;
    // One statement, so the pins of one request are written together or not at all.
    await this.pool.query(
      `INSERT INTO funding_node_pins (node_id, wallet_address, pinned_by)
       SELECT node_id, lower(wallet_address), $3
         FROM unnest($1::text[], $2::text[]) AS pin(node_id, wallet_address)
       ON CONFLICT (node_id) DO UPDATE
         SET wallet_address = EXCLUDED.wallet_address,
             pinned_at = NOW(),
             pinned_by = EXCLUDED.pinned_by`,
      [pins.map((pin) => pin.nodeId), pins.map((pin) => pin.walletAddress), pinnedBy],
    );
  }
}
