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
   * The reason for the configuration update.
   * Possible values: 'segment-modified', 'api-key-rotated'
   */
  reason: string;

  /**
   * ISO timestamp of when the change occurred.
   */
  timestamp: string;
}

/**
 * Union type for all flag events.
 * Used internally to handle both event types.
 */
export type FlagEvent =
  | { type: 'flag-updated'; data: FlagUpdatedEvent }
  | { type: 'config-updated'; data: ConfigUpdatedEvent };

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
