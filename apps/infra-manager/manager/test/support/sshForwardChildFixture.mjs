import net from 'node:net';
import { chmod } from 'node:fs/promises';

const socketPath = process.argv[2];
if (!socketPath || !socketPath.endsWith('/docker.sock')) throw new Error('Invalid synthetic socket');
process.umask(0o177);
if (process.argv[3] === 'ignore-term') process.on('SIGTERM', () => {});
const server = net.createServer((socket) => socket.on('data', (bytes) => socket.write(bytes)));
server.on('error', () => {
  process.exitCode = 1;
  server.close();
});
// A chmod that fails ends this fixture on the rejection, which its test reads as a failed start.
server.listen(socketPath, () => void chmod(socketPath, 0o600));
