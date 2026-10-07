import { useRef, useState } from 'react';

import type { SwarmSettings } from '@/swarm/settings';
import { SOURCE_NAME_MAX_LENGTH, SOURCE_TYPE_KIND, SOURCE_TYPES, type SourceType } from '@/swarm/sources';

import type { Help } from './checkSentences';
import { sourceAddressFromTyped } from './gatewayProbe';
import { HelpSteps } from './HelpSteps';
import type { CheckResult } from './providerTest';

const KEY_ENTER = 'Enter';

const TYPE_LABELS: Readonly<Record<SourceType, string>> = { gateway: 'Gateway', 'bee-node': 'Bee node' };

const ADDRESS_PLACEHOLDERS: Readonly<Record<SourceType, string>> = {
  gateway: 'https://gateway.example.com',
  'bee-node': 'http://localhost:1633',
};

const EMPTY_ADDRESS_TEXT: Readonly<Record<SourceType, string>> = {
  gateway: 'Enter the address of the gateway, for example https://gateway.example.com.',
  'bee-node': 'Enter the address of your Bee node, for example http://localhost:1633.',
};

/** What checking a new source found: that it can be added, or why not and how to fix it. */
export type AddCheck =
  /** The results of the Test, for a source the check ran it on. */
  | { readonly ok: true; readonly results?: readonly CheckResult[] }
  | { readonly ok: false; readonly text: string; readonly help: Help | null };

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'refused'; text: string; help: Help | null };

const IDLE: Status = { kind: 'idle' };

interface AddSourceProps {
  /** The kinds of provider the build lets a viewer add one of their own of. */
  readonly kinds: SwarmSettings['kinds'];
  /** Asks the address whether it is a source this viewer can read from. Never rejects. */
  readonly check: (type: SourceType, url: string) => Promise<AddCheck>;
  readonly onAdd: (source: { type: SourceType; name: string; url: string }, results?: readonly CheckResult[]) => void;
}

/**
 * Adding a source: its type, a name and an address, checked before the source is added, so a typo or a
 * node that refuses this site is said here in words rather than reaching the viewer later as a stream
 * list with nothing in it.
 */
export function AddSource({ kinds, check, onAdd }: AddSourceProps) {
  const offered = SOURCE_TYPES.filter((type) => kinds.includes(SOURCE_TYPE_KIND[type]));
  const [type, setType] = useState<SourceType>(offered.includes('bee-node') ? 'bee-node' : offered[0]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<Status>(IDLE);
  // Bumped on every check and on every change of what was typed, so a check that comes back late
  // cannot add an address the viewer no longer meant.
  const generation = useRef(0);

  const typed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      if (status.kind !== 'idle') {
        generation.current += 1;
        setStatus(IDLE);
      }
    };

  const checkAndAdd = async () => {
    if (status.kind === 'checking') {
      return;
    }
    const url = sourceAddressFromTyped(type, address);
    if (!url) {
      setStatus({ kind: 'refused', text: EMPTY_ADDRESS_TEXT[type], help: null });
      return;
    }
    const asked = ++generation.current;
    setStatus({ kind: 'checking' });
    const found = await check(type, url);
    if (asked !== generation.current) {
      return;
    }
    if (!found.ok) {
      setStatus({ kind: 'refused', text: found.text, help: found.help });
      return;
    }
    onAdd({ type, name, url }, found.results);
    generation.current += 1;
    setName('');
    setAddress('');
    setStatus(IDLE);
  };

  if (offered.length === 0) {
    return null;
  }

  return (
    <section aria-label="Add a source">
      <h4 className="gateway-tools-title">Add a source</h4>
      <div className="gateway-add-fields">
        <select
          className="gateway-tools-select"
          aria-label="Type"
          value={type}
          onChange={(event) => typed(setType)(event.target.value as SourceType)}
        >
          {offered.map((option) => (
            <option key={option} value={option}>
              {TYPE_LABELS[option]}
            </option>
          ))}
        </select>
        <input
          className="gateway-modal-input gateway-add-name"
          type="text"
          aria-label="Name"
          autoComplete="off"
          maxLength={SOURCE_NAME_MAX_LENGTH}
          placeholder={`Name, such as ${TYPE_LABELS[type]}`}
          value={name}
          onChange={(event) => typed(setName)(event.target.value)}
        />
      </div>
      <input
        className="gateway-modal-input"
        type="text"
        aria-label="Address"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder={ADDRESS_PLACEHOLDERS[type]}
        value={address}
        onChange={(event) => typed(setAddress)(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === KEY_ENTER) {
            void checkAndAdd();
          }
        }}
      />
      <p className={`gateway-modal-status ${status.kind === 'refused' ? 'error' : status.kind}`} role="status">
        {status.kind === 'checking' && (type === 'gateway' ? 'Testing the gateway...' : 'Checking the node...')}
        {status.kind === 'refused' && status.text}
      </p>
      {status.kind === 'refused' && status.help && <HelpSteps help={status.help} />}
      <div className="gateway-modal-actions">
        <span className="gateway-modal-actions-spacer" />
        <button
          className="gateway-modal-confirm"
          onClick={() => void checkAndAdd()}
          disabled={status.kind === 'checking'}
        >
          {status.kind === 'checking' ? 'Checking...' : 'Check and add'}
        </button>
      </div>
    </section>
  );
}
