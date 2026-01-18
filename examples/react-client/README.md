# Flipswitch React Demo

A simple React application demonstrating the Flipswitch SDK with real-time SSE updates.

## Running the Demo

```bash
cd sdks/javascript/examples/react-client
npm install
npm run dev
```

Then open http://localhost:5173 in your browser.

## Features

- Enter your Flipswitch API key to connect
- Displays all flags with their types, values, and evaluation reasons
- Real-time updates when flags change in the Flipswitch dashboard
- SSE connection status indicator

## How It Works

The demo uses the `FlipswitchProvider` directly (without OpenFeature) to:

1. Initialize and validate the API key
2. Evaluate all flags using `evaluateAllFlags()`
3. Listen for flag changes via the `onFlagChange` callback
4. Update individual flags using `evaluateFlag()` when they change
