import type { FlipswitchBaseOptions } from '@flipswitch-io/core';

/**
 * Configuration options for the Flipswitch server provider.
 */
export interface FlipswitchServerOptions extends FlipswitchBaseOptions {
  /**
   * Time-to-live in milliseconds for the in-memory flag cache.
   * Set to 0 to disable caching (every evaluation hits the server).
   * @default 0 (no caching — each evaluation is a fresh request)
   */
  cacheTtl?: number;
}
