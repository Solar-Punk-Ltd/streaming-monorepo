import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { throwawayRoot } from '../support/throwawayRoot.js';
import type { FirewallInventory } from '../../src/domain/ports/firewallInventoryTypes.js';

const script = fileURLToPath(new URL('../../../deploy/host/firewall-rules.sh', import.meta.url));
const root = throwawayRoot('firewall-rules-');
after(() => rmSync(root, { recursive: true, force: true }));
const runOptions = { encoding: 'utf8', timeout: 10_000 } as const;
function evidence(): FirewallInventory {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    daemonId: 'fixture-daemon',
    capturedAt: '2026-09-08T00:00:00.000Z',
    fingerprint: 'a'.repeat(64),
    profiles: [],
    claims: [],
    reservations: [],
    bindings: [],
  };
}
let sequence = 0;
function run(inventory: unknown = evidence(), args: string[] = []) {
  const path = join(root, 'inventory-' + ++sequence + '.json');
  writeFileSync(path, JSON.stringify(inventory));
  return spawnSync('bash', [script, '--iface', 'eth0', '--inventory', path, ...args], runOptions);
}
function rules(args: string[] = []): string {
  const result = run(evidence(), args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function sets(text: string): Map<string, number[]> {
  return new Map(
    [...text.matchAll(/set (\w+) \{[^}]*elements = \{([^}]*)\}/g)].map((match) => [
      match[1]!,
      match[2]!.split(',').map((value) => Number(value.trim())),
    ]),
  );
}
function chain(text: string, name: string): string[] {
  const start = text.indexOf('chain ' + name + ' {');
  assert.ok(start >= 0, 'missing chain ' + name);
  const open = text.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  while (depth && end < text.length) {
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
    end++;
  }
  return text
    .slice(open + 1, end - 1)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}
/** The IPv4 address sets, each as its CIDR blocks. */
function addressSets(text: string): Map<string, string[]> {
  return new Map(
    [...text.matchAll(/set (\w+) \{\s*type ipv4_addr;[^}]*elements = \{([^}]*)\}/g)].map((match) => [
      match[1]!,
      match[2]!.split(',').map((value) => value.trim()),
    ]),
  );
}
function toNumber(address: string): number {
  return address.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}
function inBlock(address: string, block: string): boolean {
  const [base, prefix] = block.split('/');
  const size = 2 ** (32 - Number(prefix));
  return Math.floor(toNumber(address) / size) === Math.floor(toNumber(base!) / size);
}
interface Packet {
  family: 'ipv4' | 'ipv6';
  /** The sender's IPv4 address, for a rule that admits named sources only. */
  source?: string;
  protocol: 'tcp' | 'udp';
  originalPort: number;
  destinationPort: number;
  iface?: string;
  established?: boolean;
  dnat?: boolean;
}
/** Evaluates every generated rule in order and rejects grammar the test does not understand. */
function verdict(text: string, hook: 'input' | 'forward', packet: Packet): string {
  assert.match(text, /table inet streaming_infra_manager \{/);
  const portSets = sets(text);
  const sources = addressSets(text);
  let policy = '';
  for (const line of chain(text, hook)) {
    const declaration = line.match(/^type filter hook (input|forward) priority -?\d+; policy (accept|drop);$/);
    if (declaration) {
      assert.equal(declaration[1], hook);
      policy = declaration[2]!;
      continue;
    }
    let match = true;
    let rest = line;
    rest = rest.replace(/^iifname (!= )?"([^"]+)" /, (_all, inverse: string | undefined, iface: string) => {
      const same = (packet.iface ?? 'eth0') === iface;
      match &&= inverse ? !same : same;
      return '';
    });
    rest = rest.replace(/^ip saddr @(\w+) /, (_all, name: string) => {
      const blocks = sources.get(name);
      assert.ok(blocks, 'unknown address set @' + name);
      match &&= packet.family === 'ipv4' && blocks.some((block) => inBlock(packet.source ?? '192.0.2.200', block));
      return '';
    });
    rest = rest.replace(/^ct state established,related /, () => {
      match &&= !!packet.established;
      return '';
    });
    rest = rest.replace(/^ct status (!= )?dnat /, (_all, inverse: string | undefined) => {
      match &&= inverse ? !packet.dnat : !!packet.dnat;
      return '';
    });
    rest = rest.replace(/^\(ct status & dnat\) != dnat /, () => {
      match &&= !packet.dnat;
      return '';
    });
    rest = rest.replace(/^meta l4proto \{ ([^}]+) \} /, (_all, values: string) => {
      match &&= values
        .split(',')
        .map((value) => value.trim())
        .includes(packet.protocol);
      return '';
    });
    rest = rest.replace(/^(?:meta l4proto )?(tcp|udp) /, (_all, protocol: string) => {
      match &&= packet.protocol === protocol;
      return '';
    });
    rest = rest.replace(
      /^(ct original proto-dst|dport) (@\w+|\{ [^}]+ \}|\d+(?:-\d+)?) /,
      (_all, field: string, expression: string) => {
        const port = field === 'dport' ? packet.destinationPort : packet.originalPort;
        let matches: boolean;
        if (expression.startsWith('@')) {
          const values = portSets.get(expression.slice(1));
          assert.ok(values, 'unknown set ' + expression);
          matches = values.includes(port);
        } else if (expression.startsWith('{')) matches = expression.slice(1, -1).split(',').map(Number).includes(port);
        else if (expression.includes('-')) {
          const [lo, hi] = expression.split('-').map(Number);
          matches = port >= lo! && port <= hi!;
        } else matches = port === Number(expression);
        match &&= matches;
        return '';
      },
    );
    assert.ok(['accept', 'drop'].includes(rest), 'unrecognized rule: ' + line);
    if (match) return rest;
  }
  assert.ok(policy);
  return policy;
}
function peerInventory(): FirewallInventory {
  const value = evidence();
  value.profiles.push({ name: 'a', slot: 1, status: 'STOPPED', target: 'localhost', versionId: 1 });
  value.claims.push({
    profileName: 'a',
    versionId: 1,
    buildId: 'b'.repeat(40),
    port: 11012,
    protocol: 'tcp',
    portVar: 'BEE_RUNG_480P_P2P_PORT',
    service: 'bee-uploader-480p',
  });
  value.reservations.push({
    daemonId: value.daemonId,
    profileName: 'a',
    port: 11012,
    protocol: 'tcp',
    heldServices: ['bee-uploader-480p'],
  });
  value.bindings = [{ project: 'a', service: 'bee-uploader-480p', port: 11012, protocol: 'tcp' }];
  return value;
}

describe('firewall rules from shared policy and complete inventory', () => {
  it('refuses a listed deployment with no reservation or claim evidence', () => {
    const value = peerInventory();
    value.claims = [];
    value.reservations = [];
    value.bindings = [];
    const result = run(value);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /a.*reservation|a.*coverage/);
  });

  it('tests the DNAT flag rather than comparing the complete connection status bitmap', () => {
    const text = rules();
    assert.ok(text.includes('(ct status & dnat) != dnat drop'));
    assert.ok(!text.includes('ct status != dnat'));
  });

  it('leaves a v3 rung peer port closed, because no rung service runs here', () => {
    const result = run(peerInventory());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      verdict(result.stdout, 'forward', {
        family: 'ipv6',
        protocol: 'tcp',
        originalPort: 11012,
        destinationPort: 1634,
        dnat: true,
      }),
      'drop',
    );
  });
  it('replaces only the manager table and uses both-family hooks before Docker filtering', () => {
    const text = rules();
    assert.doesNotMatch(text, /delete table inet filter|flush chain|table ip filter|flush ruleset/);
    assert.match(text, /delete table inet streaming_infra_manager/);
    assert.match(text, /type filter hook forward priority -1; policy accept;/);
  });
  for (const maxSlot of [99, 100]) {
    it('opens the exact supported sets through slot ' + maxSlot, () => {
      const portSets = sets(rules(['--max-slot', String(maxSlot)]));
      assert.equal(portSets.get('bee_p2p')!.length, maxSlot * 2);
      assert.equal(portSets.get('viewer')!.length, maxSlot);
      assert.equal(portSets.get('srt_ingest')!.length, maxSlot);
      assert.equal(portSets.has('rung_p2p'), false);
      assert.deepEqual([...portSets.keys()].sort(), ['bee_p2p', 'srt_ingest', 'viewer']);
    });
  }
  for (const family of ['ipv4', 'ipv6'] as const) {
    it('leaves every supported RTMP and API endpoint closed on ' + family, () => {
      const text = rules();
      for (let slot = 1; slot <= 100; slot++) {
        const bases = [
          10000,
          10002,
          10003,
          10005,
          10007,
          10009,
          ...(slot <= 99 ? [11001, 11002, 11003, 11004, 11005, 11006] : []),
        ];
        for (const base of bases) {
          const port = base + slot * 10;
          for (const hook of ['input', 'forward'] as const) {
            assert.equal(
              verdict(text, hook, { family, protocol: 'tcp', originalPort: port, destinationPort: port, dnat: true }),
              'drop',
              hook + ' TCP/' + port,
            );
          }
        }
      }
    });

    it('evaluates the complete ' + family + ' policy for TCP and UDP after DNAT', () => {
      const text = rules();
      for (const protocol of ['tcp', 'udp'] as const) {
        for (const port of [10000, 10010, 10012, 10013, 10015, 10017, 10019, 11991, 19999]) {
          const packet = { family, protocol, originalPort: port, destinationPort: 1633, dnat: true };
          assert.equal(verdict(text, 'forward', packet), 'drop', protocol + '/' + port);
          assert.equal(verdict(text, 'input', { ...packet, destinationPort: port }), 'drop');
        }
        const publicPort = protocol === 'tcp' ? 10016 : 10011;
        assert.equal(
          verdict(text, 'forward', { family, protocol, originalPort: publicPort, destinationPort: 1634, dnat: true }),
          'accept',
        );
        assert.equal(
          verdict(text, 'forward', {
            family,
            protocol,
            originalPort: protocol === 'tcp' ? 10011 : 10016,
            destinationPort: 1634,
            dnat: true,
          }),
          'drop',
        );
      }
      assert.equal(
        verdict(text, 'forward', { family, protocol: 'tcp', originalPort: 1633, destinationPort: 1633, dnat: false }),
        'drop',
      );
      assert.equal(
        verdict(text, 'forward', { family, protocol: 'tcp', originalPort: 9999, destinationPort: 80, dnat: true }),
        'accept',
      );
      assert.equal(
        verdict(text, 'forward', { family, protocol: 'tcp', originalPort: 20000, destinationPort: 80, dnat: true }),
        'accept',
      );
      assert.equal(
        verdict(text, 'forward', {
          family,
          protocol: 'tcp',
          originalPort: 10015,
          destinationPort: 1633,
          dnat: true,
          iface: 'internal0',
        }),
        'accept',
      );
      assert.equal(
        verdict(text, 'forward', {
          family,
          protocol: 'tcp',
          originalPort: 10015,
          destinationPort: 1633,
          established: true,
        }),
        'accept',
      );
    });
  }
  it('keeps SSH and edge listeners eligible without exempting a protected API', () => {
    const text = rules(['--ssh-port', '2222']);
    for (const port of [2222, 80, 443]) {
      assert.equal(
        verdict(text, 'input', { family: 'ipv4', protocol: 'tcp', destinationPort: port, originalPort: port }),
        'accept',
      );
    }
    const result = run(evidence(), ['--ssh-port', '10015']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ssh-port.*protected/i);
  });
  it('generates for a stopped slot 101 whose private RTMP no band claims now', () => {
    // 11012 was a slot-101 RTMP port and a rung peer port at once, and the
    // overlap was the whole of the refusal. With the rung band gone the port
    // belongs to nobody in particular, so the draft is written and simply
    // leaves it closed.
    const value = peerInventory();
    value.profiles[0]!.slot = 101;
    value.claims[0]!.portVar = 'SRS_RTMP_PORT';
    value.claims[0]!.service = 'srs';
    value.reservations[0]!.heldServices = ['srs'];
    value.bindings = [];
    const result = run(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      verdict(result.stdout, 'forward', {
        family: 'ipv4',
        protocol: 'tcp',
        originalPort: 11012,
        destinationPort: 1935,
        dnat: true,
      }),
      'drop',
    );
  });

  it('still refuses a private endpoint parked on a tuple a public band opens', () => {
    const value = peerInventory();
    value.claims[0]!.port = 10016;
    value.claims[0]!.portVar = 'SRS_RTMP_PORT';
    value.claims[0]!.service = 'srs';
    value.reservations[0]!.port = 10016;
    value.reservations[0]!.heldServices = ['srs'];
    value.bindings = [{ project: 'a', service: 'srs', port: 10016, protocol: 'tcp' }];
    const result = run(value);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /10016.*public|public.*10016/);
  });
  for (const missing of ['owner', 'claim', 'reservation', 'binding', 'daemon', 'version', 'shape'] as const) {
    it('refuses inconsistent ' + missing + ' evidence with no partial output', () => {
      const value = peerInventory();
      if (missing === 'owner') value.reservations[0]!.heldServices = [null];
      if (missing === 'claim') value.claims = [];
      if (missing === 'reservation') value.reservations = [];
      if (missing === 'binding')
        value.bindings = [{ project: 'outside', service: 'web', protocol: 'tcp', port: 10016 }];
      if (missing === 'daemon') value.reservations[0]!.daemonId = 'other';
      if (missing === 'version') value.policyVersion = 999;
      const result = run(missing === 'shape' ? { complete: true } : value);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /inventory|evidence|policy/i);
    });
  }
  it('opens no Bee API port to anyone unless sources are named', () => {
    const text = rules();
    assert.doesNotMatch(text, /saddr|bee_api/);
    assert.equal(
      verdict(text, 'forward', {
        family: 'ipv4',
        source: '203.0.113.7',
        protocol: 'tcp',
        originalPort: 10015,
        destinationPort: 1633,
        dnat: true,
      }),
      'drop',
    );
  });

  describe('with named uploader addresses on a Bee host', () => {
    const named = ['--bee-api-source', '203.0.113.7/32', '--bee-api-source', '198.51.100.0/24'];
    const bee = (text: string, hook: 'input' | 'forward', port: number, source: string, family: 'ipv4' | 'ipv6' = 'ipv4') =>
      verdict(text, hook, { family, source, protocol: 'tcp', originalPort: port, destinationPort: hook === 'input' ? port : 1633, dnat: true });

    it("admits each named address to every slot's Bee API port, and nobody else", () => {
      const text = rules(named);
      for (const hook of ['input', 'forward'] as const) {
        for (const port of [10015, 10505, 11005]) {
          assert.equal(bee(text, hook, port, '203.0.113.7'), 'accept', hook + ' ' + port + ' from the named host');
          assert.equal(bee(text, hook, port, '198.51.100.44'), 'accept', hook + ' ' + port + ' from the named /24');
          assert.equal(bee(text, hook, port, '203.0.113.8'), 'drop', hook + ' ' + port + ' from a stranger');
          assert.equal(bee(text, hook, port, '203.0.113.7', 'ipv6'), 'drop', hook + ' ' + port + ' over IPv6');
        }
      }
    });

    it('opens nothing else to them, the gateway API and the other private ports included', () => {
      const text = rules(named);
      for (const port of [10010, 10012, 10013, 10017, 10019]) {
        for (const hook of ['input', 'forward'] as const) {
          assert.equal(bee(text, hook, port, '203.0.113.7'), 'drop', hook + ' ' + port);
        }
      }
      assert.equal(
        verdict(text, 'forward', { family: 'ipv4', source: '203.0.113.7', protocol: 'udp', originalPort: 10015, destinationPort: 1633, dnat: true }),
        'drop',
        'UDP to a Bee API port',
      );
    });

    it('keeps the public bands exactly as they were', () => {
      const plain = sets(rules());
      const opened = sets(rules(named));
      for (const band of ['bee_p2p', 'srt_ingest', 'viewer']) assert.deepEqual(opened.get(band), plain.get(band), band);
    });

    it('stops at --max-slot like every other band', () => {
      const text = rules([...named, '--max-slot', '20']);
      assert.equal(bee(text, 'forward', 10205, '203.0.113.7'), 'accept');
      assert.equal(bee(text, 'forward', 10215, '203.0.113.7'), 'drop');
    });

    it('names the admitted addresses at the top of the draft', () => {
      assert.match(rules(named), /^# Bee API ports open to: 203\.0\.113\.7\/32, 198\.51\.100\.0\/24$/m);
    });
  });

  for (const source of ['0.0.0.0/0', '203.0.113.0/16', '203.0.113.7', '256.1.1.1/32', '203.0.113.7/33', '2001:db8::1/128', 'example.org/32']) {
    it('refuses --bee-api-source ' + source, () => {
      const result = run(evidence(), ['--bee-api-source', source]);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--bee-api-source/);
    });
  }

  it('requires an exporter snapshot', () => {
    const result = spawnSync('bash', [script, '--iface', 'eth0'], runOptions);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--inventory/);
  });
  for (const args of [
    ['--max-slot', '0'],
    ['--max-slot', '101'],
    ['--max-slot', '1000'],
    ['--max-slot', '010'],
    ['--max-slot', 'abc'],
    ['--max-slot', '9223372036854775808'],
    ['--ssh-port', '0'],
    ['--ssh-port', '70000'],
    ['--iface', 'eth0"quoted'],
  ]) {
    it('refuses invalid arguments ' + args.join(' '), () => {
      const result = run(evidence(), args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(args[0]!));
    });
  }
});
