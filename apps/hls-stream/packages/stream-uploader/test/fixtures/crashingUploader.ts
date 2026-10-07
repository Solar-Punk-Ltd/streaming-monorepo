/**
 * A process that holds a recovery entry, wires the uploader's signal and crash handlers as `index.ts`
 * does, and then throws from a timer, which no try/catch reaches. The shutdown it registers stands in
 * for the graceful stop, which finalizes the broadcast and removes the entry. The one argument is the
 * state folder.
 */
import { RecoveryStore } from '../../src/libs/RecoveryStore.js';
import { registerCrashHandlers, registerShutdownSignals } from '../../src/libs/processSignals.js';
import { makeRecoveredState } from '../helpers/recoveredState.js';

const STREAM_ID = 'live_stream';
const stateDir = process.argv[2];
if (!stateDir) throw new Error('usage: crashingUploader.ts <state folder>');

const store = new RecoveryStore(stateDir);
store.save(STREAM_ID, makeRecoveredState(STREAM_ID));

registerShutdownSignals({
  shutdown: async () => {
    store.remove(STREAM_ID);
  },
});
registerCrashHandlers({ error: (label, value) => console.error(label, value) });

setTimeout(() => {
  throw new Error('a timer threw');
}, 10);
// Holds the process open, so one that survives the throw exits 0 on its own a little later.
setTimeout(() => {}, 3_000);
