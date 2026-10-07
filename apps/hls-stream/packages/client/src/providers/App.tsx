import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';

import { manifestFetcher } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { exposeFetchBackendForInstrumentation } from '@/components/SwarmHlsPlayer/fetchBackendTestHandle';
import { ManifestStateManager } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { Stream } from '@/types/stream';
import type { SwarmClient } from '@/swarm/client';
import { createSwarmClient } from '@/swarm/createSwarmClient';
import { fallbackOrderFor } from '@/swarm/fallbackOrder';
import { chooseSource, type PartSources, resolveRouting, type Routing, setMode, withoutSource } from '@/swarm/routing';
import { type GatewaySetting, type SwarmSettings, swarmSettingsFrom } from '@/swarm/settings';
import {
  type AddedSource,
  addSource as withSourceAdded,
  allSources,
  gatewaySettingOf,
  type NewSource,
  removeSource as withSourceRemoved,
  renameSource as withSourceRenamed,
  type Source,
} from '@/swarm/sources';
import { CatalogFeedReader } from '@/utils/catalogFeed';
import { config } from '@/utils/config';
import { gatewayClock } from '@/utils/gatewayClock';

import { CatalogRead, catalogUpdater, StreamCatalog, toCatalogRead } from './catalogState';
import { exposeGatewayForInstrumentation } from './gatewayTestHandle';
import {
  loadSourceChoices,
  saveAddedSources,
  saveFallbackOrder,
  saveRouting,
  type SourceChoices,
} from './sourceStorage';

type AppContextState = {
  streamList: Stream[];
  /**
   * Whether the catalog has been read at least once, successfully or not.
   *
   * A stream's ABR ladder lives in the catalog, so a page opened directly on /watch knows nothing
   * about it until this flips. Mounting the player before then would start it as single-rendition
   * and rebuild it the moment the ladder arrived, losing playback position on every deep link.
   *
   * ⛔ Not reset by a gateway switch, and that is deliberate. The ladder belongs to the broadcast
   * rather than to the node serving it, and the watch page has no catalog poll of its own, so
   * clearing this there would unmount the player and leave nothing to bring it back.
   */
  isStreamListLoaded: boolean;
  /**
   * Whether {@link streamList} came from the source the stream list reads from now.
   *
   * False from the moment a viewer switches node until that node's own answer lands. The browse page
   * then says it is still looking rather than showing another node's streams, and the watch page
   * keeps the ladder it has, which is a property of the broadcast and not of the gateway.
   */
  isStreamListFromCurrentGateway: boolean;
  setNewStreamList: (read: CatalogRead) => void;
  fetchAppState: () => Promise<CatalogRead>;
  /** The one way the app reads Swarm, each part from its source with the order of fallbacks behind it. */
  swarm: SwarmClient;
  /** The gateways this build offers, its default and its fallbacks. */
  swarmSettings: SwarmSettings;
  /** The stream list feed this build reads, which the node picker's Test and status checks read too. */
  catalogFeed: { readonly owner: string; readonly topic: string };
  /** The build's gateways, then the gateways and Bee nodes the viewer added. */
  sources: readonly Source[];
  /** How the viewer chose to route the parts, as saved. */
  routing: Routing;
  /** The source each part reads from now, which is {@link routing} with any source that is gone replaced. */
  parts: PartSources;
  /** The order the fallbacks are asked in, the default gateway last, or empty when the build has none. */
  fallbackOrder: readonly string[];
  /** The source the stream list reads from, which the stream list on screen is tagged with. */
  streamListSourceId: string;
  /** Adds a source and answers its id. */
  addSource: (source: NewSource) => string;
  renameSource: (id: string, name: string) => void;
  /** Removes a source the viewer added. Whatever read from it reads from the default gateway. */
  removeSource: (id: string) => void;
  setRouting: (routing: Routing) => void;
  setFallbackOrder: (order: readonly string[]) => void;
};

const AppContext = createContext<AppContextState | undefined>(undefined);

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppContextProvider');
  }
  return context;
};

type Props = {
  children: ReactNode;
};

/** What the build names as its gateways, read once: the providers setting, or its one Bee URL. */
const SWARM_SETTINGS = swarmSettingsFrom(config);

const CATALOG_FEED = { owner: config.appOwner, topic: config.rawAppTopic };

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

interface Wiring {
  readonly sources: readonly Source[];
  readonly parts: PartSources;
  readonly fallbackOrder: readonly string[];
}

function wiringOf(choices: SourceChoices): Wiring {
  const sources = allSources(SWARM_SETTINGS, choices.added);
  return {
    sources,
    parts: resolveRouting(
      choices.routing,
      sources.map(({ id }) => id),
      SWARM_SETTINGS.defaultId,
    ),
    fallbackOrder: fallbackOrderFor(SWARM_SETTINGS, choices.fallbackOrder),
  };
}

/** What the client is made from, so a change that leaves it alone, such as a rename, does not make it again. */
function clientKey({ sources, parts, fallbackOrder }: Wiring): string {
  const urlOf = (id: string) => sources.find((source) => source.id === id)?.url ?? id;
  return JSON.stringify([Object.entries(parts).map(([part, id]) => [part, id, urlOf(id)]), fallbackOrder]);
}

/** The address a part reads from, which the instrumentation handle reports as the gateway in use. */
function addressOf({ sources, parts }: Wiring): string {
  return sources.find((source) => source.id === parts.player)?.url ?? '';
}

/**
 * The client for the parts' sources, sharing the one gateway clock the player's time markers read, so
 * the server time of the player's answers corrects them and not only the stream list's.
 */
function swarmClientFor({ sources, parts, fallbackOrder }: Wiring): SwarmClient {
  const gatewayOf = (id: string): GatewaySetting | undefined => {
    const source = sources.find((candidate) => candidate.id === id);
    return source ? gatewaySettingOf(source) : undefined;
  };
  const routes = Object.fromEntries(
    (['stream-list', 'previews'] as const).flatMap((part) => {
      const gateway = gatewayOf(parts[part]);
      return gateway ? [[part, gateway]] : [];
    }),
  );
  return createSwarmClient(SWARM_SETTINGS, {
    choice: gatewayOf(parts.player),
    routes,
    fallbackOrder,
    client: { clock: gatewayClock },
  });
}

export const AppContextProvider = ({ children }: Props) => {
  const [catalog, setCatalog] = useState<StreamCatalog>({ streams: [], gateway: null, slot: null });
  const [isStreamListLoaded, setIsStreamListLoaded] = useState(false);
  const [choices, setChoices] = useState<SourceChoices>(() => loadSourceChoices(SWARM_SETTINGS));
  const wiring = useMemo(() => wiringOf(choices), [choices]);
  const [swarm, setSwarm] = useState<SwarmClient>(() => {
    const client = swarmClientFor(wiring);
    manifestFetcher.useSwarm(client.reader('player'));
    return client;
  });
  const swarmRef = useRef(swarm);
  const choicesRef = useRef(choices);
  const wiringRef = useRef(wiring);
  const clientKeyRef = useRef(clientKey(wiring));

  const streamListSourceRef = useRef(wiring.parts['stream-list']);

  /**
   * Take the viewer's new choices and point every later read where they say. Each caller saves what
   * it changed first.
   *
   * ⛔ **The stream list is not cleared here, and that is the fix rather than an omission.** What a
   * switch changes is whose answer the list is, which the source held beside it already records, so
   * the browse page stops showing it from this moment without anything being thrown away. Clearing
   * it would reach the watch page too, where a player is mounted on a ladder read out of it and
   * nothing polls the catalog to put one back: the viewer's own node would cost them the ladder, the
   * playback position, or the whole player. It would also break the instrumentation handle's one
   * promise, that a switch repoints every fetch without remounting anything.
   */
  const applyChoices = useCallback((next: SourceChoices) => {
    choicesRef.current = next;
    setChoices(next);
    const nextWiring = wiringOf(next);
    wiringRef.current = nextWiring;
    const key = clientKey(nextWiring);
    if (key === clientKeyRef.current) {
      return;
    }
    clientKeyRef.current = key;
    const client = swarmClientFor(nextWiring);
    swarmRef.current = client;
    setSwarm(client);
    manifestFetcher.useSwarm(client.reader('player'));
    if (nextWiring.parts['stream-list'] !== streamListSourceRef.current) {
      streamListSourceRef.current = nextWiring.parts['stream-list'];
      // The new source has its own view of the feed, so a position established against the old one
      // would ask it for slots it may not hold, which reads as a catalog that stopped rather than one
      // being followed from the wrong place.
      catalogReader.current.reset();
    }
    ManifestStateManager.getInstance().markAllDirty();
  }, []);

  const addSource = useCallback(
    (source: NewSource) => {
      const { sources: added, id } = withSourceAdded(choicesRef.current.added, source);
      saveAddedSources(added);
      applyChoices({ ...choicesRef.current, added });
      return id;
    },
    [applyChoices],
  );

  const renameSource = useCallback(
    (id: string, name: string) => {
      const added = withSourceRenamed(choicesRef.current.added, id, name);
      saveAddedSources(added);
      applyChoices({ ...choicesRef.current, added });
    },
    [applyChoices],
  );

  const removeSource = useCallback(
    (id: string) => {
      const added: AddedSource[] = withSourceRemoved(choicesRef.current.added, id);
      const routing = withoutSource(choicesRef.current.routing, id, SWARM_SETTINGS.defaultId);
      saveAddedSources(added);
      saveRouting(routing);
      applyChoices({ ...choicesRef.current, added, routing });
    },
    [applyChoices],
  );

  const setRouting = useCallback(
    (routing: Routing) => {
      saveRouting(routing);
      applyChoices({ ...choicesRef.current, routing });
    },
    [applyChoices],
  );

  const setFallbackOrder = useCallback(
    (order: readonly string[]) => {
      saveFallbackOrder(order);
      applyChoices({ ...choicesRef.current, fallbackOrder: order });
    },
    [applyChoices],
  );

  /**
   * Reads every part from the source at this address, the one a source already has or a Bee node added
   * for it, which is what the instrumentation handle's switch means.
   */
  const readEverythingFrom = useCallback(
    (url: string) => {
      const address = withoutTrailingSlash(url);
      const current = choicesRef.current;
      const known = allSources(SWARM_SETTINGS, current.added).find(
        (source) => withoutTrailingSlash(source.url) === address,
      );
      const { sources: added, id } = known
        ? { sources: [...current.added], id: known.id }
        : withSourceAdded(current.added, { type: 'bee-node', name: '', url: address });
      const routing = chooseSource(setMode(current.routing, 'one'), id);
      saveAddedSources(added);
      saveRouting(routing);
      applyChoices({ ...current, added, routing });
    },
    [applyChoices],
  );

  /**
   * Kept in a ref rather than rebuilt per call, because its whole value is the position it remembers
   * between polls. A reader recreated on each render would resolve the head every time, which is the
   * cost this replaces.
   */
  const catalogReader = useRef(new CatalogFeedReader(config.appOwner, Topic.fromString(config.rawAppTopic)));

  /**
   * A read that landed, with the feed slot its body came from, and a null body when nothing was newer
   * than the last poll.
   *
   * The head is resolved once, on the first call, and every call after asks for the slot after the
   * one it holds. See `CatalogFeedReader` for why that is worth about a thousand times at the median.
   */
  const fetchAppState = useCallback(async (): Promise<CatalogRead> => {
    const source = streamListSourceRef.current;
    return toCatalogRead(source, await catalogReader.current.read(swarmRef.current.reader('stream-list')));
  }, []);

  /**
   * Stable, and applied through the state it is updating rather than through a captured copy.
   *
   * ⛔ A new function on every render is what let a poll be applied twice: the browse page's effect
   * depends on this, so it re-ran on every render of this provider and handed the previous poll's
   * body back in, which would put a gateway's streams back on screen right after a switch cleared
   * them.
   */
  const setNewStreamList = useCallback((read: CatalogRead) => {
    setCatalog(catalogUpdater(read, streamListSourceRef));
  }, []);

  const initAppState = useCallback(async () => {
    try {
      setNewStreamList(await fetchAppState());
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    } finally {
      // Also on failure: a catalog that cannot be read is not a reason to withhold the player
      // forever, and a stream deep-linked without its ladder still plays as a single rendition.
      setIsStreamListLoaded(true);
    }
  }, [fetchAppState, setNewStreamList]);

  useEffect(() => {
    // Catches its own failure and marks the list loaded either way.
    void initAppState();
  }, [initAppState]);

  // Only present in a build made with VITE_EXPOSE_PLAYER, which no shipping build is. The switch holds
  // no dependencies that change, so this publishes once per mount rather than on every render.
  useEffect(
    () =>
      exposeGatewayForInstrumentation({
        current: () => addressOf(wiringRef.current),
        select: readEverythingFrom,
      }) ?? undefined,
    [readEverythingFrom],
  );

  // The byte-source switch, beside the gateway one and behind the same flag. It holds no React state
  // of its own, so it publishes once per mount and depends on nothing.
  useEffect(() => exposeFetchBackendForInstrumentation() ?? undefined, []);

  return (
    <AppContext.Provider
      value={{
        streamList: catalog.streams,
        isStreamListLoaded,
        isStreamListFromCurrentGateway: catalog.gateway === wiring.parts['stream-list'],
        setNewStreamList,
        fetchAppState,
        swarm,
        swarmSettings: SWARM_SETTINGS,
        catalogFeed: CATALOG_FEED,
        sources: wiring.sources,
        routing: choices.routing,
        parts: wiring.parts,
        fallbackOrder: wiring.fallbackOrder,
        streamListSourceId: wiring.parts['stream-list'],
        addSource,
        renameSource,
        removeSource,
        setRouting,
        setFallbackOrder,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
