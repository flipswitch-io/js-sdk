import { useState, useEffect, useCallback, useRef } from 'react';
import { FlipswitchProvider, FlagEvaluation, SseConnectionStatus } from '@flipswitch-io/sdk';

// Dark mode color palette (matching Flipswitch frontend)
const colors = {
  background: '#0f1419',
  foreground: '#e2e8f0',
  card: '#1a1f2e',
  cardElevated: '#242938',
  muted: '#1a1f2e',
  mutedForeground: '#94a3b8',
  border: '#2d3548',
  primary: '#0d9488',
  primaryLight: '#14b8a6',
  success: '#10b981',
  successBg: 'rgba(16, 185, 129, 0.1)',
  successBorder: 'rgba(16, 185, 129, 0.3)',
  error: '#ef4444',
  errorBg: 'rgba(239, 68, 68, 0.1)',
  errorBorder: 'rgba(239, 68, 68, 0.3)',
  warning: '#f59e0b',
};

const context = {
  targetingKey: 'user-123',
  email: 'user@example.com',
  plan: 'premium',
  country: 'SE',
};

function App() {
  const [apiKey, setApiKey] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flags, setFlags] = useState<FlagEvaluation[]>([]);
  const [sseStatus, setSseStatus] = useState<SseConnectionStatus>('disconnected');
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const providerRef = useRef<FlipswitchProvider | null>(null);

  const loadFlags = useCallback(async () => {
    if (!providerRef.current) return;
    const allFlags = await providerRef.current.evaluateAllFlags(context);
    setFlags(allFlags);
  }, []);

  const handleFlagChange = useCallback(async (flagKey: string | null) => {
    if (!providerRef.current) return;

    setLastUpdate(flagKey ? `Flag "${flagKey}" changed` : 'All flags invalidated');

    if (flagKey) {
      const updatedFlag = await providerRef.current.evaluateFlag(flagKey, context);
      if (updatedFlag) {
        setFlags(prev => prev.map(f => f.key === flagKey ? updatedFlag : f));
      }
    } else {
      await loadFlags();
    }
  }, [loadFlags]);

  const connect = async () => {
    if (!apiKey.trim()) {
      setError('Please enter an API key');
      return;
    }

    setIsConnecting(true);
    setError(null);

    const provider = new FlipswitchProvider({ apiKey: apiKey.trim() });
    provider.on('flagChange', (event: { flagKey: string | null }) => {
      handleFlagChange(event.flagKey);
    });
    provider.on('connectionStatusChange', (status: SseConnectionStatus) => {
      setSseStatus(status);
    });

    try {
      await provider.initialize();
      providerRef.current = provider;
      setIsConnected(true);
      setSseStatus(provider.getSseStatus());

      const allFlags = await provider.evaluateAllFlags(context);
      setFlags(allFlags);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      providerRef.current = null;
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = async () => {
    if (providerRef.current) {
      await providerRef.current.onClose();
      providerRef.current = null;
    }
    setIsConnected(false);
    setFlags([]);
    setSseStatus('disconnected');
    setLastUpdate(null);
  };

  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.onClose();
      }
    };
  }, []);

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getTypeColor = (type: string): string => {
    switch (type) {
      case 'boolean': return colors.success;
      case 'string': return colors.warning;
      case 'number': return '#3b82f6';
      case 'integer': return '#3b82f6';
      case 'object': return '#a855f7';
      case 'array': return '#ec4899';
      default: return colors.mutedForeground;
    }
  };

  const getSseStatusColor = (status: SseConnectionStatus): string => {
    switch (status) {
      case 'connected': return colors.success;
      case 'connecting': return colors.warning;
      case 'error': return colors.error;
      default: return colors.mutedForeground;
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 8, color: colors.foreground, fontWeight: 600 }}>
        Flipswitch React Demo
      </h1>
      <p style={{ color: colors.mutedForeground, marginTop: 0, marginBottom: 24 }}>
        Real-time feature flag evaluation with SSE updates
      </p>

      {!isConnected ? (
        <div style={{
          background: colors.card,
          padding: 24,
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
        }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block',
              marginBottom: 8,
              fontWeight: 500,
              color: colors.foreground,
            }}>
              API Key
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your environment API key"
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 14,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                background: colors.cardElevated,
                color: colors.foreground,
                outline: 'none',
              }}
              onFocus={(e) => e.target.style.borderColor = colors.primary}
              onBlur={(e) => e.target.style.borderColor = colors.border}
              onKeyDown={(e) => e.key === 'Enter' && connect()}
            />
          </div>

          {error && (
            <div style={{
              color: colors.error,
              background: colors.errorBg,
              padding: 12,
              borderRadius: 6,
              marginBottom: 16,
              border: `1px solid ${colors.errorBorder}`,
            }}>
              {error}
            </div>
          )}

          <button
            onClick={connect}
            disabled={isConnecting}
            style={{
              background: colors.primary,
              color: 'white',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 500,
              cursor: isConnecting ? 'wait' : 'pointer',
              opacity: isConnecting ? 0.7 : 1,
              transition: 'background 0.2s',
            }}
            onMouseOver={(e) => !isConnecting && (e.currentTarget.style.background = colors.primaryLight)}
            onMouseOut={(e) => (e.currentTarget.style.background = colors.primary)}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      ) : (
        <div>
          <div style={{
            background: colors.card,
            padding: 16,
            borderRadius: 8,
            marginBottom: 16,
            border: `1px solid ${colors.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: getSseStatusColor(sseStatus),
                  boxShadow: sseStatus === 'connected' ? `0 0 8px ${colors.success}` : 'none',
                }}/>
                <span style={{ fontWeight: 500, color: colors.foreground }}>
                  SSE: {sseStatus}
                </span>
              </div>
              {lastUpdate && (
                <div style={{ fontSize: 13, color: colors.mutedForeground, marginTop: 4 }}>
                  Last update: {lastUpdate}
                </div>
              )}
            </div>
            <button
              onClick={disconnect}
              style={{
                background: colors.cardElevated,
                color: colors.foreground,
                border: `1px solid ${colors.border}`,
                padding: '8px 16px',
                borderRadius: 6,
                fontSize: 14,
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseOver={(e) => e.currentTarget.style.background = colors.muted}
              onMouseOut={(e) => e.currentTarget.style.background = colors.cardElevated}
            >
              Disconnect
            </button>
          </div>

          <div style={{
            background: colors.cardElevated,
            padding: 12,
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
            color: colors.mutedForeground,
            border: `1px solid ${colors.border}`,
          }}>
            <strong style={{ color: colors.foreground }}>Context:</strong> targetingKey=user-123, email=user@example.com, plan=premium, country=SE
          </div>

          <div style={{
            background: colors.card,
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${colors.border}`,
              fontWeight: 600,
              color: colors.foreground,
            }}>
              Flags ({flags.length})
            </div>

            {flags.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: colors.mutedForeground }}>
                No flags found
              </div>
            ) : (
              <div>
                {flags.map((flag, index) => (
                  <div
                    key={flag.key}
                    style={{
                      padding: '14px 16px',
                      borderBottom: index < flags.length - 1 ? `1px solid ${colors.border}` : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontWeight: 500,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: colors.foreground,
                      }}>
                        {flag.key}
                      </span>
                      <span style={{
                        background: getTypeColor(flag.valueType),
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 500,
                      }}>
                        {flag.valueType}
                      </span>
                    </div>
                    <div style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 14,
                      color: colors.primaryLight,
                      marginBottom: 4
                    }}>
                      {formatValue(flag.value)}
                    </div>
                    <div style={{ fontSize: 12, color: colors.mutedForeground }}>
                      reason={flag.reason}
                      {flag.variant && <span>, variant={flag.variant}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{
            marginTop: 16,
            padding: 16,
            background: colors.successBg,
            borderRadius: 8,
            border: `1px solid ${colors.successBorder}`,
          }}>
            <div style={{ fontWeight: 500, color: colors.success, marginBottom: 4 }}>
              Listening for real-time updates
            </div>
            <div style={{ fontSize: 13, color: colors.success, opacity: 0.8 }}>
              Change a flag in the Flipswitch dashboard to see it update here automatically.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
