/**
 * Flipswitch JavaScript SDK Demo
 *
 * Run this demo with:
 *   npm run demo -- <your-api-key> [base-url]
 *
 * Or directly:
 *   npx tsx examples/demo.ts <your-api-key> [base-url]
 *
 * Or set the FLIPSWITCH_BASE_URL environment variable:
 *   FLIPSWITCH_BASE_URL=http://localhost:8080 npm run demo -- <your-api-key>
 */

import { FlipswitchProvider, FlagEvaluation } from '../src';

const apiKey = process.argv[2];
const baseUrl = process.argv[3] || process.env.FLIPSWITCH_BASE_URL;

if (!apiKey) {
  console.error('Usage: npm run demo -- <api-key> [base-url]');
  console.error('       Or set FLIPSWITCH_BASE_URL environment variable');
  process.exit(1);
}

// Evaluation context
const context = {
  targetingKey: 'user-123',
  email: 'user@example.com',
  plan: 'premium',
  country: 'SE',
};

let provider: FlipswitchProvider;

function printFlag(flag: FlagEvaluation) {
  const variant = flag.variant ? `, variant=${flag.variant}` : '';
  console.log(`  ${flag.key.padEnd(30)} (${flag.valueType}) = ${provider.formatValue(flag.value)}`);
  console.log(`    └─ reason=${flag.reason}${variant}`);
}

async function printAllFlags() {
  const flags = await provider.evaluateAllFlags(context);

  if (flags.length === 0) {
    console.log('No flags found.');
    return;
  }

  console.log(`Flags (${flags.length}):`);
  console.log('-'.repeat(60));

  for (const flag of flags) {
    printFlag(flag);
  }
}

async function main() {
  console.log('Flipswitch JavaScript SDK Demo');
  console.log('==============================\n');

  if (baseUrl) {
    console.log(`Using base URL: ${baseUrl}`);
  }

  // Create provider - only API key is required
  provider = new FlipswitchProvider(
    { apiKey, baseUrl },
    {
      onFlagChange: async (event) => {
        const flagKey = event.flagKey;
        console.log(`\n*** Flag changed: ${flagKey ?? 'all flags'} ***`);

        if (flagKey) {
          // Re-evaluate the specific flag that changed
          const flag = await provider.evaluateFlag(flagKey, context);
          if (flag) {
            printFlag(flag);
          }
        } else {
          // Bulk invalidation - re-evaluate all flags
          await printAllFlags();
        }
        console.log();
      },
      onConnectionStatusChange: (status) => {
        if (status === 'error') {
          console.log('\n[SSE] Connection error - will reconnect...');
        } else if (status === 'connected') {
          console.log('[SSE] Connected');
        }
      },
    }
  );

  // Initialize the provider
  try {
    await provider.initialize();
  } catch (error) {
    console.error(`Failed to connect to Flipswitch: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log(`Connected! SSE Status: ${provider.getSseStatus()}`);

  console.log('\nEvaluating flags for user: user-123');
  console.log('Context: email=user@example.com, plan=premium, country=SE\n');

  await printAllFlags();

  console.log('\n--- Listening for real-time flag updates (Ctrl+C to exit) ---');
  console.log('Change a flag in the Flipswitch dashboard to see it here!\n');

  // Keep running for 5 minutes
  await new Promise((resolve) => setTimeout(resolve, 300000));

  await provider.onClose();
  console.log('\nDemo complete!');
}

main().catch(console.error);
