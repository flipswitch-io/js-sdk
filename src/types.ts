/**
 * Configuration options for the Flipswitch provider.
 */
export interface FlipswitchOptions {
  /**
   * The API key for your environment.
   * Obtain this from your Flipswitch dashboard.
   */
  apiKey: string;

  /**
   * The base URL of your Flipswitch server.
   * @default 'https://api.flipswitch.io'
   */
  baseUrl?: string;

  /**
   * Enable real-time flag updates via SSE.
   * When enabled, the provider will connect to the SSE endpoint
   * and automatically invalidate cached flags when changes occur.
   * @default true
   */
  enableRealtime?: boolean;

  /**
   * Custom fetch function for making HTTP requests.
   * Useful for testing or custom networking needs.
   */
  fetchImplementation?: typeof fetch;

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

  /**
   * Enable polling fallback when SSE fails.
   * After maxSseRetries, the provider will fall back to polling.
   * @default true
   */
  enablePollingFallback?: boolean;

  /**
   * Polling interval in milliseconds for fallback mode.
   * Only used when SSE connection fails and polling fallback is enabled.
   * @default 30000 (30 seconds)
   */
  pollingInterval?: number;

  /**
   * Maximum SSE retry attempts before falling back to polling.
   * @default 5
   */
  maxSseRetries?: number;
}

/**
 * Event emitted when a single flag is updated.
 */
export interface FlagUpdatedEvent {
  /**
   * The key of the flag that changed.
   */
  flagKey: string;

  /**
   * ISO timestamp of when the change occurred.
   */
  timestamp: string;
}

/**
 * Event emitted when configuration changes that may affect multiple flags.
 */
export interface ConfigUpdatedEvent {
  /**
   * ISO timestamp of when the change occurred.
   */
  timestamp: string;
}

/**
 * Event emitted when an API key has been rotated.
 */
export interface ApiKeyRotatedEvent {
  /**
   * ISO timestamp when the current key expires.
   */
  validUntil: string;

  /**
   * ISO timestamp of when the rotation occurred.
   */
  timestamp: string;
}

/**
 * Union type for all flag events.
 * Used internally to handle event types.
 */
export type FlagEvent =
  | { type: 'flag-updated'; data: FlagUpdatedEvent }
  | { type: 'config-updated'; data: ConfigUpdatedEvent }
  | { type: 'api-key-rotated'; data: ApiKeyRotatedEvent };

/**
 * @deprecated Use FlagUpdatedEvent or ConfigUpdatedEvent instead.
 * Event emitted when a flag changes (legacy format).
 */
export interface FlagChangeEvent {
  /**
   * The key of the flag that changed, or null for bulk invalidation.
   */
  flagKey: string | null;

  /**
   * ISO timestamp of when the change occurred.
   */
  timestamp: string;
}

/**
 * SSE connection status.
 */
export type SseConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Event handler types for the provider.
 */
export interface FlipswitchEventHandlers {
  /**
   * Called when a flag changes.
   */
  onFlagChange?: (event: FlagChangeEvent) => void;

  /**
   * Called when the SSE connection status changes.
   */
  onConnectionStatusChange?: (status: SseConnectionStatus) => void;
}

/**
 * Represents the result of evaluating a single flag.
 */
export interface FlagEvaluation {
  /**
   * The flag key.
   */
  key: string;

  /**
   * The evaluated value.
   */
  value: unknown;

  /**
   * The inferred type of the value.
   */
  valueType: 'boolean' | 'string' | 'number' | 'object' | 'array' | 'null' | 'unknown';

  /**
   * The reason for this evaluation result.
   */
  reason: string | null;

  /**
   * The variant that matched, if applicable.
   */
  variant: string | null;
}
