export { FlipswitchWebProvider } from './provider';
export { BrowserCache } from './browser-cache';
export type { FlipswitchWebOptions } from './types';

// Re-export commonly used types from core
export type {
  FlagChangeEvent,
  FlagUpdatedEvent,
  ConfigUpdatedEvent,
  ApiKeyRotatedEvent,
  FlagEvent,
  SseConnectionStatus,
  FlagChangeHandler,
  ConnectionStatusHandler,
  Unsubscribe,
  FlagEvaluation,
} from '@flipswitch-io/core';
export { SseClient, FlagCache, formatValue } from '@flipswitch-io/core';
