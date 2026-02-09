# @flipswitch-io/sdk

[![CI](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@flipswitch-io/sdk.svg)](https://www.npmjs.com/package/@flipswitch-io/sdk)
[![codecov](https://codecov.io/gh/flipswitch-io/js-sdk/branch/main/graph/badge.svg)](https://codecov.io/gh/flipswitch-io/js-sdk)

Flipswitch SDK for JavaScript/TypeScript with real-time SSE support for OpenFeature.

This SDK provides an OpenFeature-compatible provider that wraps OFREP flag evaluation with automatic cache invalidation via Server-Sent Events (SSE). When flags change in your Flipswitch dashboard, connected clients receive updates in real-time.

## Overview

- **OpenFeature Compatible**: Works with the OpenFeature standard for feature flags 
- **Real-Time Updates**: SSE connection delivers instant flag changes
- **Browser Optimized**: Visibility API integration, localStorage persistence, offline support
- **Polling Fallback**: Automatic fallback when SSE connection fails
- **TypeScript First**: Full type definitions included

## Requirements

- Node.js 18+ or modern browsers (Chrome, Firefox, Safari, Edge)
- OpenFeature SDK (`@openfeature/web-sdk` or `@openfeature/server-sdk`)

## Installation

```bash
npm install @flipswitch-io/sdk @openfeature/web-sdk
# or for server
npm install @flipswitch-io/sdk @openfeature/server-sdk
```

## Quick Start

### Browser (React, Vue, etc.)

```typescript
import { FlipswitchProvider } from '@flipswitch-io/sdk';
import { OpenFeature } from '@openfeature/web-sdk';

const provider = new FlipswitchProvider({
  apiKey: 'your-environment-api-key'
});

await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient();

const darkMode = await client.getBooleanValue('dark-mode', false);
```

### Node.js (Server)

```typescript
import { FlipswitchProvider } from '@flipswitch-io/sdk';
import { OpenFeature } from '@openfeature/server-sdk';

const provider = new FlipswitchProvider({
  apiKey: 'your-environment-api-key'
});

await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient();

const context = {
  targetingKey: 'user-123',
  email: 'user@example.com',
  plan: 'premium',
};

const showFeature = await client.getBooleanValue('new-feature', false, context);
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | Environment API key from dashboard |
| `baseUrl` | `string` | `https://api.flipswitch.io` | Your Flipswitch server URL |
| `enableRealtime` | `boolean` | `true` | Enable SSE for real-time flag updates |
| `fetchImplementation` | `typeof fetch` | `fetch` | Custom fetch function |
| `persistCache` | `boolean` | `true` (browser) | Persist flag values to localStorage |
| `offlineMode` | `boolean` | `true` (browser) | Enable offline support with cached values |
| `enableVisibilityHandling` | `boolean` | `true` (browser) | Pause SSE when tab is hidden |
| `enablePollingFallback` | `boolean` | `true` | Fall back to polling when SSE fails |
| `pollingInterval` | `number` | `30000` | Polling interval in ms (fallback mode) |
| `maxSseRetries` | `number` | `5` | Max SSE retries before polling fallback |

## Usage Examples

### Basic Flag Evaluation

```typescript
const client = OpenFeature.getClient();

// Boolean flag
const darkMode = await client.getBooleanValue('dark-mode', false);

// String flag
const welcomeMessage = await client.getStringValue('welcome-message', 'Hello!');

// Number flag
const maxItems = await client.getNumberValue('max-items', 10);

// Object flag
const config = await client.getObjectValue('feature-config', { enabled: false });
```

### Evaluation Context

Target specific users or segments:

```typescript
const context = {
  targetingKey: 'user-123',     // Unique user identifier
  email: 'user@example.com',
  plan: 'premium',
  country: 'US',
  betaUser: true,
};

const showFeature = await client.getBooleanValue('new-feature', false, context);
```

### Real-Time Updates (SSE)

The SDK automatically listens for flag changes via SSE:

```typescript
const provider = new FlipswitchProvider(
  { apiKey: 'your-api-key' },
  {
    onFlagChange: (event) => {
      console.log(`Flag changed: ${event.flagKey ?? 'all flags'}`);
      // event.flagKey is null for bulk invalidation
    },
    onConnectionStatusChange: (status) => {
      console.log(`SSE status: ${status}`);
      // 'connecting' | 'connected' | 'disconnected' | 'error'
    },
  }
);

// Check current status
const status = provider.getSseStatus();

// Force reconnect
provider.reconnectSse();
```

### Bulk Flag Evaluation

Evaluate all flags at once:

```typescript
const flags = await provider.evaluateAllFlags(context);
for (const flag of flags) {
  console.log(`${flag.key} (${flag.valueType}): ${flag.value}`);
  console.log(`  Reason: ${flag.reason}, Variant: ${flag.variant}`);
}

// Single flag with full details
const flag = await provider.evaluateFlag('dark-mode', context);
if (flag) {
  console.log(`Value: ${flag.value}`);
  console.log(`Reason: ${flag.reason}`);
  console.log(`Variant: ${flag.variant}`);
}
```

## Advanced Features

### Offline Support (Browser)

When offline mode is enabled, the SDK:
- Detects online/offline state via `navigator.onLine`
- Serves cached values when offline
- Automatically refreshes when connection is restored

```typescript
const provider = new FlipswitchProvider({
  apiKey: 'your-api-key',
  offlineMode: true,        // Enable offline support
  persistCache: true,       // Persist to localStorage
});

// Check online status
if (provider.isOnline()) {
  console.log('Online - flags are fresh');
} else {
  console.log('Offline - serving cached values');
}
```

### Visibility API Integration (Browser)

The SDK automatically pauses SSE when the browser tab is hidden to save resources:

```typescript
const provider = new FlipswitchProvider({
  apiKey: 'your-api-key',
  enableVisibilityHandling: true, // default: true in browsers
});

// Connection is paused when tab is hidden
// Connection resumes when tab becomes visible
```

### Polling Fallback

When SSE connection fails repeatedly, the SDK falls back to polling:

```typescript
const provider = new FlipswitchProvider({
  apiKey: 'your-api-key',
  enablePollingFallback: true, // default: true
  pollingInterval: 30000,      // Poll every 30 seconds
  maxSseRetries: 5,            // Fall back after 5 failed SSE attempts
});

// Check if polling is active
if (provider.isPollingActive()) {
  console.log('Polling fallback is active');
}
```

### Custom HTTP Client

Provide a custom fetch implementation for testing or special requirements:

```typescript
import nodeFetch from 'node-fetch';

const provider = new FlipswitchProvider({
  apiKey: 'your-api-key',
  fetchImplementation: nodeFetch as unknown as typeof fetch,
});
```

## Framework Integration

### React

```tsx
import { OpenFeature, OpenFeatureProvider, useFlag } from '@openfeature/react-sdk';
import { FlipswitchProvider } from '@flipswitch-io/sdk';

const provider = new FlipswitchProvider({ apiKey: 'your-api-key' });
await OpenFeature.setProviderAndWait(provider);

function App() {
  return (
    <OpenFeatureProvider>
      <MyComponent />
    </OpenFeatureProvider>
  );
}

function MyComponent() {
  const { value: darkMode, isLoading } = useFlag('dark-mode', false);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className={darkMode ? 'dark' : 'light'}>
      Dark mode is {darkMode ? 'enabled' : 'disabled'}
    </div>
  );
}
```

### Vue 3

```vue
<script setup>
import { ref, onMounted } from 'vue';
import { OpenFeature } from '@openfeature/web-sdk';
import { FlipswitchProvider } from '@flipswitch-io/sdk';

const darkMode = ref(false);
const client = OpenFeature.getClient();

onMounted(async () => {
  const provider = new FlipswitchProvider({ apiKey: 'your-api-key' });
  await OpenFeature.setProviderAndWait(provider);
  darkMode.value = await client.getBooleanValue('dark-mode', false);
});
</script>

<template>
  <div :class="darkMode ? 'dark' : 'light'">
    Dark mode is {{ darkMode ? 'enabled' : 'disabled' }}
  </div>
</template>
```

## Error Handling

The SDK handles errors gracefully and provides fallback behavior:

```typescript
try {
  const provider = new FlipswitchProvider({ apiKey: 'your-api-key' });
  await OpenFeature.setProviderAndWait(provider);
} catch (error) {
  console.error('Failed to initialize provider:', error);
  // Provider will use default values
}

// Flag evaluation never throws - returns default value on error
const value = await client.getBooleanValue('my-flag', false);
```

## Logging & Debugging

Enable console logging to debug issues:

```typescript
// The SDK logs to console with [Flipswitch] prefix
// Look for messages like:
// [Flipswitch] SSE connection established
// [Flipswitch] Flag changed: my-flag
// [Flipswitch] SSE connection error, retrying...
// [Flipswitch] Starting polling fallback
```

## Testing

Mock the provider in your tests:

```typescript
import { OpenFeature, InMemoryProvider } from '@openfeature/web-sdk';

// Use InMemoryProvider for testing
const testProvider = new InMemoryProvider({
  'dark-mode': { defaultVariant: 'on', variants: { on: true, off: false } },
  'max-items': { defaultVariant: 'default', variants: { default: 10 } },
});

await OpenFeature.setProviderAndWait(testProvider);

// Your tests can now evaluate flags without network calls
```

## API Reference

### FlipswitchProvider

```typescript
class FlipswitchProvider {
  constructor(options: FlipswitchOptions, eventHandlers?: FlipswitchEventHandlers);

  // OpenFeature Provider interface
  initialize(context?: EvaluationContext): Promise<void>;
  onClose(): Promise<void>;
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext): ResolutionDetails<boolean>;
  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext): ResolutionDetails<string>;
  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext): ResolutionDetails<number>;
  resolveObjectEvaluation<T>(flagKey: string, defaultValue: T, context: EvaluationContext): ResolutionDetails<T>;

  // Flipswitch-specific methods
  getSseStatus(): SseConnectionStatus;
  reconnectSse(): void;
  isOnline(): boolean;
  isPollingActive(): boolean;
  evaluateAllFlags(context: EvaluationContext): Promise<FlagEvaluation[]>;
  evaluateFlag(flagKey: string, context: EvaluationContext): Promise<FlagEvaluation | null>;
}
```

### Types

```typescript
interface FlipswitchOptions {
  apiKey: string;
  baseUrl?: string;
  enableRealtime?: boolean;
  fetchImplementation?: typeof fetch;
  persistCache?: boolean;
  offlineMode?: boolean;
  enableVisibilityHandling?: boolean;
  enablePollingFallback?: boolean;
  pollingInterval?: number;
  maxSseRetries?: number;
}

type SseConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface FlagChangeEvent {
  flagKey: string | null;
  timestamp: string;
}

interface FlagEvaluation {
  key: string;
  value: unknown;
  valueType: 'boolean' | 'string' | 'number' | 'object' | 'array' | 'null' | 'unknown';
  reason: string | null;
  variant: string | null;
}
```

## Troubleshooting

### SSE Connection Fails

- Check that your API key is valid
- Verify your server URL is correct
- Check for network/firewall issues blocking SSE
- The SDK will automatically fall back to polling

### Flags Not Updating in Real-Time

- Ensure `enableRealtime` is not set to `false`
- Check SSE status with `provider.getSseStatus()`
- Verify the SSE endpoint is accessible
- Check browser console for error messages

### Offline Mode Not Working

- Verify `offlineMode` is enabled
- Check that localStorage is available
- Clear browser storage if cache is corrupted

## Demo

Run the included demo:

```bash
npm install
npm run demo -- <your-api-key>
```

The demo will connect, display all flags, and listen for real-time updates.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.
