# @flipswitch-io/sdk

[![CI](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@flipswitch-io/sdk.svg)](https://www.npmjs.com/package/@flipswitch-io/sdk)

Flipswitch SDK for JavaScript/TypeScript with real-time SSE support for OpenFeature.

This SDK provides an OpenFeature-compatible provider that wraps OFREP flag evaluation with automatic cache invalidation
via Server-Sent Events (SSE). When flags change in your Flipswitch dashboard, connected clients receive updates in
real-time.

## Installation

```bash
npm install @flipswitch-io/sdk @openfeature/web-sdk
# or
npm install @flipswitch-io/sdk @openfeature/server-sdk
```

## Quick Start

### Browser (React, Vue, etc.)

```typescript
import { FlipswitchProvider } from '@flipswitch-io/sdk';
import { OpenFeature } from '@openfeature/web-sdk';

// Only API key is required
const provider = new FlipswitchProvider({
  apiKey: 'your-environment-api-key'
});

// Register with OpenFeature
await OpenFeature.setProviderAndWait(provider);

// Get a client and evaluate flags
const client = OpenFeature.getClient();
const darkMode = await client.getBooleanValue('dark-mode', false);
const welcomeMessage = await client.getStringValue('welcome-message', 'Hello!');
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

// Evaluate with context
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
| `pollingInterval` | `number` | `30000` | Cache TTL in milliseconds |
| `fetchImplementation` | `typeof fetch` | `fetch` | Custom fetch function |

## Real-Time Updates

When `enableRealtime` is enabled, the SDK maintains a Server-Sent Events (SSE) connection to receive instant flag change notifications. When a flag changes:

1. The SSE client receives a `flag-change` event
2. The local cache is immediately invalidated
3. Next flag evaluation fetches the fresh value
4. OpenFeature emits a `PROVIDER_CONFIGURATION_CHANGED` event

### Event Handlers

```typescript
const provider = new FlipswitchProvider(
  { apiKey: 'your-api-key' },
  {
    onFlagChange: (event) => {
      console.log(`Flag changed: ${event.flagKey}`);
    },
    onConnectionStatusChange: (status) => {
      console.log(`SSE status: ${status}`);
    },
  }
);
```

### Connection Status

```typescript
// Check current SSE status
const status = provider.getSseStatus();
// 'connecting' | 'connected' | 'disconnected' | 'error'

// Force reconnect
provider.reconnectSse();
```

## React Integration

```tsx
import { OpenFeature, OpenFeatureProvider, useFlag } from '@openfeature/react-sdk';
import { FlipswitchProvider } from '@flipswitch-io/sdk';

// Initialize provider
const provider = new FlipswitchProvider({
  baseUrl: 'https://api.flipswitch.io',
  apiKey: 'your-api-key',
});

await OpenFeature.setProviderAndWait(provider);

function App() {
  return (
    <OpenFeatureProvider>
      <MyComponent />
    </OpenFeatureProvider>
  );
}

function MyComponent() {
  const { value: darkMode } = useFlag('dark-mode', false);

  return (
    <div className={darkMode ? 'dark' : 'light'}>
      Dark mode is {darkMode ? 'enabled' : 'disabled'}
    </div>
  );
}
```

## Bulk Flag Evaluation

Evaluate all flags at once or get detailed evaluation results:

```typescript
// Evaluate all flags
const flags = await provider.evaluateAllFlags(context);
for (const flag of flags) {
  console.log(`${flag.key} (${flag.valueType}): ${flag.value}`);
}

// Evaluate a single flag with full details
const flag = await provider.evaluateFlag('dark-mode', context);
if (flag) {
  console.log(`Value: ${flag.value}, Reason: ${flag.reason}, Variant: ${flag.variant}`);
}
```

## Reconnection Strategy

The SSE client automatically reconnects with exponential backoff:
- Initial delay: 1 second
- Maximum delay: 30 seconds
- Backoff multiplier: 2x

When reconnected, the provider status changes from `STALE` back to `READY`.

## Demo

A complete working demo is included. To run it:

```bash
npm install
npm run demo -- <your-api-key>
```

The demo will:
1. Connect to Flipswitch and validate your API key
2. Load and display all flags with their types and values
3. Listen for real-time flag changes and display updates

See [examples/demo.ts](./examples/demo.ts) for the full source.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.
