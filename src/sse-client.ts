import type { FlagChangeEvent, SseConnectionStatus } from './types';

const MIN_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30000;

/**
 * SSE client for real-time flag change notifications.
 * Handles automatic reconnection with exponential backoff.
 */
export class SseClient {
  private eventSource: EventSource | null = null;
  private retryDelay = MIN_RETRY_DELAY;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private status: SseConnectionStatus = 'disconnected';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly onFlagChange: (event: FlagChangeEvent) => void,
    private readonly onStatusChange?: (status: SseConnectionStatus) => void,
    private readonly telemetryHeaders?: Record<string, string>
  ) {}

  /**
   * Start the SSE connection.
   */
  connect(): void {
    if (this.closed) return;
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.updateStatus('connecting');

    // Build the SSE URL
    const url = `${this.baseUrl}/api/v1/flags/events`;

    // Create EventSource
    // Note: EventSource doesn't support custom headers natively.
    // We use a polyfill approach by passing the API key as a query param
    // or using EventSource polyfill that supports headers.
    // For now, we'll use the native EventSource with a workaround.
    try {
      // Check if we're in a browser environment with native EventSource
      if (typeof EventSource !== 'undefined') {
        // Use fetch-event-source pattern for header support
        this.connectWithFetch(url);
      } else {
        // Node.js environment - use polyfill
        this.connectWithPolyfill(url);
      }
    } catch (error) {
      console.error('[Flipswitch] Failed to establish SSE connection:', error);
      this.updateStatus('error');
      this.scheduleReconnect();
    }
  }

  /**
   * Connect using fetch-based SSE (supports custom headers).
   */
  private async connectWithFetch(url: string): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'X-API-Key': this.apiKey,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.telemetryHeaders,
      };

      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      this.updateStatus('connected');
      this.retryDelay = MIN_RETRY_DELAY;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processStream = async (): Promise<void> => {
        while (!this.closed) {
          const { done, value } = await reader.read();

          if (done) {
            // Stream ended, reconnect
            this.updateStatus('disconnected');
            this.scheduleReconnect();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete events in the buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              eventData = line.slice(5).trim();
            } else if (line === '' && eventData) {
              // Empty line marks end of event
              this.handleEvent(eventType, eventData);
              eventType = '';
              eventData = '';
            }
          }
        }
      };

      processStream().catch((error) => {
        if (!this.closed) {
          console.error('[Flipswitch] SSE stream error:', error);
          this.updateStatus('error');
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      if (!this.closed) {
        console.error('[Flipswitch] SSE connection error:', error);
        this.updateStatus('error');
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Connect using native EventSource (for environments that support it).
   * Note: This requires server-side support for API key in query params.
   */
  private connectWithPolyfill(url: string): void {
    // For Node.js, we'd need to use a library like 'eventsource'
    // For now, fall back to fetch-based approach
    this.connectWithFetch(url);
  }

  /**
   * Handle incoming SSE events.
   */
  private handleEvent(eventType: string, data: string): void {
    if (eventType === 'heartbeat') {
      // Heartbeat received, connection is alive
      return;
    }

    if (eventType === 'flag-change') {
      try {
        const event: FlagChangeEvent = JSON.parse(data);
        this.onFlagChange(event);
      } catch (error) {
        console.error('[Flipswitch] Failed to parse flag-change event:', error);
      }
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.closed) return;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      if (!this.closed) {
        this.connect();
        // Increase backoff delay for next attempt
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
      }
    }, this.retryDelay);
  }

  /**
   * Update and broadcast connection status.
   */
  private updateStatus(status: SseConnectionStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  /**
   * Get current connection status.
   */
  getStatus(): SseConnectionStatus {
    return this.status;
  }

  /**
   * Close the SSE connection and stop reconnection attempts.
   */
  close(): void {
    this.closed = true;
    this.updateStatus('disconnected');

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
