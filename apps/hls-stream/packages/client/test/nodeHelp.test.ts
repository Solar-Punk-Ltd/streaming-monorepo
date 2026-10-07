import { describe, expect, it } from 'vitest';

import {
  corsHelp,
  LOCAL_NETWORK_HELP,
  UNREACHABLE_SENTENCES,
  unreachableSentence,
} from '../src/components/DomainSelector/checkSentences';

const ORIGIN = 'https://viewer.example.com';

describe("the help for a node that refuses this site's origin", () => {
  const help = corsHelp(ORIGIN);

  it("gives the exact line for Bee's config file, the flag and the environment variable, for this page's origin", () => {
    expect(help.steps.map(({ code }) => code)).toEqual([
      'cors-allowed-origins: ["https://viewer.example.com"]',
      'bee start --cors-allowed-origins=https://viewer.example.com',
      'BEE_CORS_ALLOWED_ORIGINS=https://viewer.example.com',
    ]);
  });

  it('says where each goes, and to restart the node', () => {
    expect(help.intro).toContain('restart');
    expect(help.steps.map(({ label }) => label)).toEqual([
      "In the node's config file, often bee.yaml:",
      'Or on the command line:',
      'Or as an environment variable:',
    ]);
  });

  it('notes Swarm Desktop, which allows every site unless its own config was changed', () => {
    expect(help.note).toBe(
      "Swarm Desktop writes cors-allowed-origins: '*' into its own config.yaml, which allows every site. If your Swarm Desktop node refuses this site, put that line back and restart Swarm Desktop.",
    );
  });

  it('names whatever origin it is given rather than any domain of its own', () => {
    expect(JSON.stringify(corsHelp('http://localhost:5173'))).not.toContain('example');
  });
});

describe("the help for the browser's local network question", () => {
  it('explains the prompt and that a refusal is remembered', () => {
    expect(LOCAL_NETWORK_HELP.intro).toBe(
      'The first time a site reaches a device on your network or a program on this computer, your browser asks whether to allow it. A Block is remembered for this site. To undo it:',
    );
  });

  it('says how to undo a refusal in Chrome, Edge and Firefox, then to reload', () => {
    expect(LOCAL_NETWORK_HELP.steps).toEqual([
      {
        label: 'Chrome:',
        text: 'Click the icon to the left of the address, open Site settings, and set Local network access to Allow.',
      },
      {
        label: 'Edge:',
        text: 'Open Settings, then Privacy, search, and services, Site permissions, All permissions, Local network access, and allow this site.',
      },
      {
        label: 'Firefox:',
        text: 'Open Settings, then Privacy & Security, Permissions, and allow this site under Local network devices, or under Device apps and services for a node on this computer.',
      },
    ]);
    expect(LOCAL_NETWORK_HELP.note).toBe('Then reload this page and try again.');
  });
});

describe('the sentence for each reason a node could not be reached', () => {
  it.each([
    [
      'unreachable',
      'Nothing answers at this address. Check that the node is running and that the address and port are right. The Bee API is usually on port 1633.',
    ],
    [
      'cors-refused',
      "Something answers at this address, but it does not let this site read from it. If it is your Bee node, add this site to the node's cors-allowed-origins setting, then restart the node.",
    ],
    [
      'local-network-refused',
      'Your browser is blocking this site from reaching your local network and this computer, so the request never reached the node.',
    ],
    [
      'unreachable-local',
      'Nothing answered at this address. Check that the node is running and the port is right. If your browser asked whether this site may reach devices on your local network, the answer has to be Allow.',
    ],
  ] as const)('%s', (kind, sentence) => {
    expect(unreachableSentence({ kind })).toBe(sentence);
    expect(UNREACHABLE_SENTENCES[kind]).toBe(sentence);
  });

  it('keeps every sentence and step free of dashes and semicolons', () => {
    const all = [
      ...Object.values(UNREACHABLE_SENTENCES),
      JSON.stringify(LOCAL_NETWORK_HELP),
      corsHelp(ORIGIN).intro,
      corsHelp(ORIGIN).note,
      ...corsHelp(ORIGIN).steps.map(({ label }) => label),
    ];
    for (const sentence of all) {
      expect(sentence).not.toMatch(/[—;]/);
    }
  });
});
