import type { AnsClientOptions } from './client.js';

export type { AnsClientOptions };

export interface AnsClientConfig {
  serverUrl: string;
  cacheTTL: number;
}
