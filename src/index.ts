/**
 * dsh-chatjimmy — use the chatjimmy.ai model inside DeepSeek Harness.
 *
 * One capability: an `ctx.llm` provider adapter for the reconstructed chat API
 * (see `API.md`). Registering it makes the route selectable in the Web client's
 * model picker, because `buildModelCatalog()` enumerates `ctx.llm.listProviders()`
 * and asks each adapter for `listModels()` / `resolveModel()`.
 *
 * See README.md for the known limits — the service has no tool-calling, no
 * image input, and a 6144-token total context.
 *
 * @module dsh-chatjimmy
 */

import Schema from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { ChatJimmyAdapter } from './adapter.ts'
import type { ChatJimmyConfig } from './protocol.ts'
import type { HostContext } from './host.ts'

/** Plugin name as it appears in the loader. */
export const name = 'chatjimmy'

/** The `ctx.llm` provider route this adapter owns. */
export const PROVIDER = 'chatjimmy'

/** The one service this plugin needs mounted. */
export const inject = ['llm']

/**
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * The exported schema is what Cordis validates the row against and fills
 * defaults from; `resolveConfig` then normalizes the validated values.
 */
export interface Config {
  /** Deployment origin. Defaults to `https://chatjimmy.ai`. */
  readonly baseUrl?: string
  /** Model id sent as `chatOptions.selectedModel`. Defaults to `llama3.1-8B`. */
  readonly model?: string
  /** Forwarded as `chatOptions.topK`. The site's own client sends 8. */
  readonly topK?: number
  /**
   * Total context window in tokens used for call-config validation. Measured
   * against the live service at 6144 (prompt + completion).
   */
  readonly contextWindow?: number
  /**
   * Per-read stream idle watchdog in milliseconds; a stream that produces
   * nothing for this long ends with the `TIMEOUT` failure.
   */
  readonly streamIdleTimeoutMs?: number
  /**
   * Provider-owned retry policy for this route, in the harness
   * `RetryPolicyConfig` shape (`{ mode: 'normal' | 'always', … }`). Absent
   * leaves the harness's own normal defaults.
   */
  readonly retryPolicy?: RetryPolicyConfig
}

/**
 * Total context the backend enforces, in tokens, measured empirically:
 * a request whose reported `prefill_tokens` reached 6141 with 2 output tokens
 * succeeded, while one needing 6143 + 2 returned a zero-byte body. The site's
 * own client caps at the same number (`NEXT_PUBLIC_TOKEN_LIMIT`, default 6144).
 */
const CONTEXT_WINDOW = 6144

/** Model the service serves. `/api/models` advertises exactly this one id. */
const DEFAULT_MODEL = 'llama3.1-8B'

/** Base URL of the deployment. */
const DEFAULT_BASE_URL = 'https://chatjimmy.ai'

/** Per-read stream idle watchdog default, matching the shipped remote adapters. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** `setTimeout`'s maximum delay; a larger configured timeout is rejected at load. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Row schema: defaults live here, so a deployment only states what it changes. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(DEFAULT_BASE_URL),
  model: Schema.string().default(DEFAULT_MODEL),
  topK: Schema.number().step(1).min(1).default(8),
  contextWindow: Schema.number().step(1).min(1).default(CONTEXT_WINDOW),
  streamIdleTimeoutMs: Schema.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/**
 * Validate and normalize one configuration row.
 *
 * The row is fed back through the exported `Config` schema, which is the one
 * source of the defaults and the numeric bounds — Cordis already ran the same
 * schema before `apply`, so this only makes `resolveConfig` usable on its own.
 * What the schema cannot express is checked here: invalid values throw rather
 * than being silently defaulted, because a typo'd base URL would otherwise
 * present as an opaque transport failure on the first message.
 *
 * @param config - raw row configuration.
 * @returns the resolved adapter configuration.
 */
export function resolveConfig(config: Config = {}): ChatJimmyConfig {
  const resolved = Config(config) as ChatJimmyConfig
  const baseUrl = resolved.baseUrl.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`chatjimmy: baseUrl "${resolved.baseUrl}" is not a valid absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`chatjimmy: baseUrl "${resolved.baseUrl}" must use http or https`)
  }
  // Any string is a valid model id to the schema, but the empty one is not a model.
  if (resolved.model.trim().length === 0) throw new Error('chatjimmy: model must be a non-empty string')

  // `min`/`max` cannot see NaN (every comparison against it is false, so NaN
  // passes both), and schemastery has no refinement hook. One explicit check.
  for (const field of ['topK', 'contextWindow', 'streamIdleTimeoutMs'] as const) {
    if (!Number.isFinite(resolved[field])) {
      throw new Error(`chatjimmy: ${field} must be a finite number, got ${String(resolved[field])}`)
    }
  }

  return { ...resolved, baseUrl }
}

/**
 * Mount the adapter.
 * @param ctx - host context; `ctx.llm` must be mounted (`inject` guarantees it).
 * @param config - this plugin's row configuration.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.llm.registerAdapter([PROVIDER], new ChatJimmyAdapter(resolved))
  ctx.logger.info(
    `chatjimmy: provider "${PROVIDER}" registered for model "${resolved.model}" at ${resolved.baseUrl}`
      + ` (text only, ${resolved.contextWindow}-token total context)`,
  )
}
