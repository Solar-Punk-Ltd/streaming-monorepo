import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, PlaylistLoaderContext } from 'hls.js';
import Hls from 'hls.js';

/**
 * The address a stream card gives hls.js for its one-segment playlist, which the loader below answers
 * from memory, so nothing ever asks the network for it.
 *
 * ⛔ Not a blob URL. hls.js reads a playlist with XHR, so a blob URL is governed by `connect-src`, and
 * the Devcon client's image names no blob source there. A card handed a blob showed nothing on that
 * deployed site, while every run without the policy passed. This image sets no policy yet, and
 * answering here means one that does can stay that narrow.
 *
 * Its own scheme rather than a path on the site, so a relative media line still cannot resolve to a
 * real host: hls.js 1.7.3 resolves `/bytes/<ref>` against it to `memory:preview.m3u8/bytes/<ref>`,
 * which `CustomFragmentLoader` refuses as naming no gateway.
 */
export const PREVIEW_PLAYLIST_URL = 'memory:preview.m3u8';

const PlaylistLoader = Hls.DefaultConfig.loader as unknown as {
  new (config: HlsConfig): Loader<PlaylistLoaderContext>;
};

/** A playlist loader for one card, answering {@link PREVIEW_PLAYLIST_URL} with `playlist`. */
export function previewPlaylistLoader(playlist: string): typeof PlaylistLoader {
  return class PreviewPlaylistLoader extends PlaylistLoader {
    private settled = false;

    load(
      context: PlaylistLoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>,
    ): void {
      if (context.url !== PREVIEW_PLAYLIST_URL) {
        callbacks.onError(
          { code: 0, text: `a preview asks only for its own playlist, not ${context.url}` },
          context,
          null,
          this.stats,
        );
        return;
      }
      // Answered on a later tick, as a transfer would be, so hls.js has finished setting up the request
      // before it hears the result. A teardown in between is honoured through `abort`.
      void Promise.resolve().then(() => {
        if (this.settled) {
          return;
        }
        this.settled = true;
        callbacks.onSuccess({ url: context.url, data: playlist, code: 200 }, this.stats, context, null);
      });
    }

    abort(): void {
      this.settled = true;
      super.abort();
    }

    destroy(): void {
      this.settled = true;
      super.destroy();
    }
  };
}
