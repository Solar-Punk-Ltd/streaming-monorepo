/**
 * Where a probe reads and writes. READ_URL names the gateway's Bee API and WRITE_URL the uploader's.
 * Where one is unset it is derived from PORT_SLOT, the stage's `--portSlot`, on this host's loopback,
 * which is where a probe run with `--network host` beside the stage reaches it.
 *
 * Plain ESM, like the probes that import it, so `node` runs them without a build. The slot arithmetic
 * mirrors `apply_port_slot` in `deploy/scripts/_lib.sh`, and the test compares it with `src/ports.ts`.
 */

const LOOPBACK = '127.0.0.1';
const MAX_PORT_SLOT = 99;
const PORT_SLOT_STRIDE = 10;
const GATEWAY_BEE_API = { stock: 1733, base: 10007 };
const UPLOADER_BEE_API = { stock: 1633, base: 10005 };

/**
 * @param {{ stock: number, base: number }} port
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function slotUrl(port, name, env) {
  const raw = env.PORT_SLOT;
  if (raw === undefined || raw === '') {
    throw new Error(
      `${name} is unset and so is PORT_SLOT. Name the Bee API in ${name}, or the stage's port slot in PORT_SLOT`,
    );
  }
  if (!/^[0-9]{1,2}$/.test(raw) || Number(raw) > MAX_PORT_SLOT) {
    throw new Error(`PORT_SLOT must be an integer 0-${MAX_PORT_SLOT}, as --portSlot takes, and is "${raw}"`);
  }
  const slot = Number(raw);
  const hostPort = slot === 0 ? port.stock : port.base + slot * PORT_SLOT_STRIDE;
  return `http://${LOOPBACK}:${hostPort}`;
}

/**
 * The gateway Bee API a probe reads through.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function probeReadUrl(env = process.env) {
  return env.READ_URL || slotUrl(GATEWAY_BEE_API, 'READ_URL', env);
}

/**
 * The uploader Bee API a probe writes through.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function probeWriteUrl(env = process.env) {
  return env.WRITE_URL || slotUrl(UPLOADER_BEE_API, 'WRITE_URL', env);
}
