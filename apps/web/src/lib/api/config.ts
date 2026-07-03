import { apiClient } from './client';

/** Public server feature flags, read once at load (no auth required). */
export interface ServerConfig {
  /** Whether the per-project terminal WebSocket endpoint is enabled server-side. */
  terminalEnabled: boolean;
}

/** GET /config - the server's public feature flags. */
export function getServerConfig(): Promise<ServerConfig> {
  return apiClient.get<ServerConfig>('/config');
}
