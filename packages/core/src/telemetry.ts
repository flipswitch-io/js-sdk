/**
 * Build telemetry headers for Flipswitch API requests.
 */
export function buildTelemetryHeaders(sdkVersion: string, enableRealtime: boolean): Record<string, string> {
  return {
    'X-Flipswitch-SDK': getSdkHeader(sdkVersion),
    'X-Flipswitch-Runtime': getRuntimeHeader(),
    'X-Flipswitch-OS': getOsHeader(),
    'X-Flipswitch-Features': getFeaturesHeader(enableRealtime),
  };
}

function getSdkHeader(sdkVersion: string): string {
  return `javascript/${sdkVersion}`;
}

function getRuntimeHeader(): string {
  if (typeof process !== 'undefined' && process.versions?.node) {
    return `node/${process.versions.node}`;
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (ua.includes('Chrome')) {
      const match = ua.match(/Chrome\/(\d+)/);
      return `chrome/${match?.[1] ?? 'unknown'}`;
    }
    if (ua.includes('Firefox')) {
      const match = ua.match(/Firefox\/(\d+)/);
      return `firefox/${match?.[1] ?? 'unknown'}`;
    }
    if (ua.includes('Safari') && !ua.includes('Chrome')) {
      const match = ua.match(/Version\/(\d+)/);
      return `safari/${match?.[1] ?? 'unknown'}`;
    }
    return 'browser/unknown';
  }
  return 'unknown/unknown';
}

function getOsHeader(): string {
  if (typeof process !== 'undefined' && process.platform) {
    const platform = process.platform;
    const arch = process.arch;
    const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : platform;
    return `${os}/${arch}`;
  }
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    let os = 'unknown';
    let arch = 'unknown';

    if (ua.includes('mac')) os = 'darwin';
    else if (ua.includes('win')) os = 'windows';
    else if (ua.includes('linux')) os = 'linux';
    else if (ua.includes('android')) os = 'android';
    else if (ua.includes('iphone') || ua.includes('ipad')) os = 'ios';

    if (ua.includes('arm64') || ua.includes('aarch64')) arch = 'arm64';
    else if (ua.includes('x64') || ua.includes('x86_64') || ua.includes('amd64')) arch = 'amd64';

    return `${os}/${arch}`;
  }
  return 'unknown/unknown';
}

function getFeaturesHeader(enableRealtime: boolean): string {
  return `sse=${enableRealtime}`;
}
