import type { FlipswitchBaseOptions } from '@flipswitch-io/core';

/**
 * Configuration options for the Flipswitch web provider.
 */
export interface FlipswitchWebOptions extends FlipswitchBaseOptions {
  /**
   * Persist flag values to localStorage (browser only).
   * When enabled, flag values are cached in localStorage and used
   * as fallback when offline or during initial load.
   * @default true (in browser environments)
   */
  persistCache?: boolean;

  /**
   * Enable offline mode support.
   * When enabled, the provider will detect offline state and serve
   * cached values without attempting network requests.
   * @default true (in browser environments)
   */
  offlineMode?: boolean;

  /**
   * Enable visibility API integration (browser only).
   * When enabled, SSE connection is paused when the tab is hidden
   * and resumed when it becomes visible, saving resources.
   * @default true (in browser environments)
   */
  enableVisibilityHandling?: boolean;
}
