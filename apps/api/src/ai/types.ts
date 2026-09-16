import type { ProviderId, TaskId } from '../config.js';

export interface LLMImage {
  data: string; // base64 (no data: prefix)
  mimeType: string; // image/png | image/jpeg
}

export interface LLMRequest {
  task: TaskId;
  system: string;
  input: string;
  images?: LLMImage[];
  /** Request JSON-only output (provider-level guarantee when supported). */
  json: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResult {
  text: string;
  /** Parsed JSON object when json:true and the response parsed; null otherwise. */
  json: unknown | null;
  provider: ProviderId | 'heuristic';
  model: string;
  latencyMs: number;
}

/** Error whose `retryable` flag tells the router whether another attempt (or provider) makes sense. */
export class AiError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  primary: boolean;
  inFallback: boolean;
  defaults: { deep: string; fast: string };
}
