# Flipswitch JavaScript SDKs

[![CI](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/flipswitch-io/js-sdk/actions/workflows/ci.yml)

Flipswitch OpenFeature providers for JavaScript/TypeScript with real-time SSE support.

This monorepo contains two providers — one for the browser and one for Node.js — that wrap OFREP flag evaluation with automatic cache invalidation via Server-Sent Events (SSE). When flags change in your Flipswitch dashboard, connected clients receive updates in real-time.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@flipswitch-io/web-provider`](./packages/web) | Browser provider (React, Vue, etc.) | [![npm](https://img.shields.io/npm/v/@flipswitch-io/web-provider.svg)](https://www.npmjs.com/package/@flipswitch-io/web-provider) |
| [`@flipswitch-io/server-provider`](./packages/server) | Node.js server provider | [![npm](https://img.shields.io/npm/v/@flipswitch-io/server-provider.svg)](https://www.npmjs.com/package/@flipswitch-io/server-provider) |

## Which package should I use?

- **Browser apps** (React, Vue, Angular, etc.) → `@flipswitch-io/web-provider`
- **Server apps** (Express, Fastify, Next.js API routes, etc.) → `@flipswitch-io/server-provider`

The key difference: the **web provider** pre-fetches all flags on init and resolves them synchronously from cache, while the **server provider** evaluates each flag per-request with async HTTP calls and per-request context.

## Requirements

- Node.js 18+ or modern browsers (Chrome, Firefox, Safari, Edge)
- OpenFeature SDK (`@openfeature/web-sdk` or `@openfeature/server-sdk`)

## Quick Start

### Browser (React, Vue, etc.)

```bash
npm install @flipswitch-io/web-provider @openfeature/web-sdk
```

```typescript
import { FlipswitchWebProvider } from '@flipswitch-io/web-provider';
import { OpenFeature } from '@openfeature/web-sdk';

const provider = new FlipswitchWebProvider({
  apiKey: 'your-environment-api-key'
});

await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient();

const darkMode = await client.getBooleanValue('dark-mode', false);
```

### Node.js (Server)

```bash
npm install @flipswitch-io/server-provider @openfeature/server-sdk
```

```typescript
import { FlipswitchServerProvider } from '@flipswitch-io/server-provider';
import { OpenFeature } from '@openfeature/server-sdk';

const provider = new FlipswitchServerProvider({
  apiKey: 'your-environment-api-key'
});

await OpenFeature.setProviderAndWait(provider);
const client = OpenFeature.getClient();

// Each evaluation is an async HTTP request with per-request context
const showFeature = await client.getBooleanValue('new-feature', false, {
  targetingKey: 'user-123',
  email: 'user@example.com',
  plan: 'premium',
});
```

## Configuration Options

### Shared options (both providers)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | Environment API key from dashboard |
| `baseUrl` | `string` | `https://api.flipswitch.io` | Your Flipswitch server URL |
| `enableRealtime` | `boolean` | `true` | Enable SSE for real-time flag updates |
| `fetchImplementation` | `typeof fetch` | `fetch` | Custom fetch function |
| `enablePollingFallback` | `boolean` | `true` | Fall back to polling when SSE fails |
| `pollingInterval` | `number` | `30000` | Polling interval in ms (fallback mode) |
| `maxSseRetries` | `number` | `5` | Max SSE retries before polling fallback |

### Web provider only

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `persistCache` | `boolean` | `true` (browser) | Persist flag values to localStorage |
| `offlineMode` | `boolean` | `true` (browser) | Enable offline support with cached values |
| `enableVisibilityHandling` | `boolean` | `true` (browser) | Pause SSE when tab is hidden |

### Server provider only

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cacheTtl` | `number` | `0` | In-memory cache TTL in ms (0 = no caching) |

## Real-Time Updates (SSE)

Both providers support real-time flag change notifications:

```typescript
// Listen for all flag changes (flagKey is null for bulk invalidation)
provider.on('flagChange', (event) => {
  console.log(`Flag changed: ${event.flagKey ?? 'all flags'}`);
});

// Listen for a specific flag (also fires on bulk invalidation)
const unsub = provider.on('flagChange', 'dark-mode', (event) => {
  console.log('dark-mode changed, re-evaluating...');
});
unsub(); // stop listening

// Monitor SSE connection status
provider.on('connectionStatusChange', (status) => {
  console.log(`SSE status: ${status}`);
});

provider.getSseStatus();  // current status
provider.reconnectSse();  // force reconnect
```

## Bulk Flag Evaluation

Both providers support evaluating all flags at once:

```typescript
const flags = await provider.evaluateAllFlags(context);
for (const flag of flags) {
  console.log(`${flag.key} (${flag.valueType}): ${flag.value}`);
}

// Single flag with full details
const flag = await provider.evaluateFlag('dark-mode', context);
```

## Browser-Specific Features

### Offline Support

```typescript
const provider = new FlipswitchWebProvider({
  apiKey: 'your-api-key',
  offlineMode: true,
  persistCache: true,
});

if (provider.isOnline()) {
  console.log('Online - flags are fresh');
} else {
  console.log('Offline - serving cached values');
}
```

### Visibility API Integration

The web provider automatically pauses SSE when the browser tab is hidden to save resources, and resumes when the tab becomes visible again.

## Framework Integration

### React

```tsx
import { OpenFeature, OpenFeatureProvider, useFlag } from '@openfeature/react-sdk';
import { FlipswitchWebProvider } from '@flipswitch-io/web-provider';

const provider = new FlipswitchWebProvider({ apiKey: 'your-api-key' });
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

## Testing

Mock the provider in your tests:

```typescript
import { OpenFeature, InMemoryProvider } from '@openfeature/web-sdk';

const testProvider = new InMemoryProvider({
  'dark-mode': { defaultVariant: 'on', variants: { on: true, off: false } },
  'max-items': { defaultVariant: 'default', variants: { default: 10 } },
});

await OpenFeature.setProviderAndWait(testProvider);
```

## Demo

Run the server provider demo:

```bash
npm install
npm run demo:server -- <your-api-key>
```

## Migration from `@flipswitch-io/sdk`

The old `@flipswitch-io/sdk` package has been replaced by platform-specific providers.

### For web/browser users

```diff
- import { FlipswitchProvider } from '@flipswitch-io/sdk';
+ import { FlipswitchWebProvider } from '@flipswitch-io/web-provider';

- const provider = new FlipswitchProvider({ apiKey: 'xxx' });
+ const provider = new FlipswitchWebProvider({ apiKey: 'xxx' });
```

### For server/Node.js users

```diff
- import { FlipswitchProvider } from '@flipswitch-io/sdk';
- import { OpenFeature } from '@openfeature/server-sdk';
+ import { FlipswitchServerProvider } from '@flipswitch-io/server-provider';
+ import { OpenFeature } from '@openfeature/server-sdk';

- const provider = new FlipswitchProvider({ apiKey: 'xxx' });
+ const provider = new FlipswitchServerProvider({ apiKey: 'xxx' });
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](LICENSE) for details.
