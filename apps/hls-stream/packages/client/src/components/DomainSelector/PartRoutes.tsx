import type { SwarmFeature } from '@/swarm/client';
import { type PartSources, type Routing, setLinked, setPart } from '@/swarm/routing';
import type { Source } from '@/swarm/sources';

import { FEATURE_LABELS } from './providerStatus';

const PARTS: readonly SwarmFeature[] = ['player', 'stream-list', 'previews'];

const UNLINKED_NOTE = 'Live timing may slip while video and stream list differ.';

interface PartRoutesProps {
  readonly sources: readonly Source[];
  readonly routing: Routing;
  /** The source each part reads from now, which is what each select shows. */
  readonly parts: PartSources;
  readonly onChange: (routing: Routing) => void;
}

/**
 * Per part: a source for the video, the stream list and the previews, each from the same list of
 * sources, with the video and the stream list linked until the viewer unlinks them.
 */
export function PartRoutes({ sources, routing, parts, onChange }: PartRoutesProps) {
  return (
    <section aria-label="Source per part">
      <dl className="gateway-tools-status">
        {PARTS.map((part) => (
          <div key={part} data-part={part}>
            <dt>{FEATURE_LABELS[part]}</dt>
            <dd>
              <select
                className="gateway-tools-select"
                aria-label={FEATURE_LABELS[part]}
                value={parts[part]}
                onChange={(event) => onChange(setPart(routing, part, event.target.value))}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </dd>
          </div>
        ))}
      </dl>
      <label className="gateway-tools-note">
        <input
          type="checkbox"
          aria-label="Link video and stream list"
          checked={routing.linked}
          onChange={(event) => onChange(setLinked(routing, event.target.checked))}
        />{' '}
        Video and stream list read from the same source
      </label>
      {!routing.linked && <p className="gateway-tools-note">{UNLINKED_NOTE}</p>}
    </section>
  );
}
