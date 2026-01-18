/**
 * @flipswitch/sdk
 *
 * Flipswitch SDK with real-time SSE support for OpenFeature.
 *
 * This SDK wraps OFREP-compatible flag evaluation with automatic
 * cache invalidation via Server-Sent Events (SSE). When flags change
 * in your Flipswitch dashboard, connected clients receive updates
 * in real-time.
 *
 * @example
 * ```typescript
 * import { FlipswitchProvider } from '@flipswitch/sdk';
 * import { OpenFeature } from '@openfeature/web-sdk';
 *
 * // Only API key is required
 * const provider = new FlipswitchProvider({
 *   apiKey: 'your-api-key'
 * });
 *
 * await OpenFeature.setProviderAndWait(provider);
 * const client = OpenFeature.getClient();
 *
 * // Flags automatically update when changed in dashboard
 * const darkMode = await client.getBooleanValue('dark-mode', false);
 * ```
 */

export { FlipswitchProvider } from './provider';
export { SseClient } from './sse-client';
export { FlagCache } from './cache';
export type {
  FlipswitchOptions,
  FlagChangeEvent,
  SseConnectionStatus,
  FlipswitchEventHandlers,
  FlagEvaluation,
} from './types';
