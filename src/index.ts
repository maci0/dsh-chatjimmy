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

import { ChatJimmyAdapter } from './adapter.ts'
import {
  CONTEXT_WINDOW,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type ChatJimmyConfig,
} from './protocol.ts'
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
 * No Schemastery `Config` schema is exported: the loader would then require a
 * Standard Schema, and this plugin validates its own row instead — the same
 * shape the other plugins under `~/dsh-plugins` use.
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
}

/**
 * Validate and normalize one configuration row.
 *
 * Invalid values throw rather than being silently defaulted: a typo'd base URL
 * would otherwise present as an opaque transport failure on the first message.
 *
 * @param config - raw row configuration.
 * @returns the resolved adapter configuration.
 */
export function resolveConfig(config: Config = {}): ChatJimmyConfig {
  const rawBase = config.baseUrl ?? DEFAULT_BASE_URL
  const baseUrl = rawBase.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`chatjimmy: baseUrl "${rawBase}" is not a valid absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`chatjimmy: baseUrl "${rawBase}" must use http or https`)
  }

  const model = config.model ?? DEFAULT_MODEL
  if (model.trim().length === 0) throw new Error('chatjimmy: model must be a non-empty string')

  const topK = config.topK ?? 8
  if (!Number.isInteger(topK) || topK < 1) throw new Error(`chatjimmy: topK must be a positive integer, got ${String(config.topK)}`)

  const contextWindow = config.contextWindow ?? CONTEXT_WINDOW
  if (!Number.isInteger(contextWindow) || contextWindow < 1) {
    throw new Error(`chatjimmy: contextWindow must be a positive integer, got ${String(config.contextWindow)}`)
  }

  return { baseUrl, model, topK, contextWindow }
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
