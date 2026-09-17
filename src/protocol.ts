/**
 * Wire translation between the harness request vocabulary and the
 * chatjimmy.ai HTTP API reconstructed in `API.md`.
 *
 * Everything here is pure so it can be tested without a harness or a network.
 *
 * @module dsh-chatjimmy/protocol
 */

import type { ContentBlock, GenerateOptions, TokenUsage } from './host.ts'

/** Opening marker of the trailing generation-stats block. */
export const STATS_OPEN = '<|stats|>'
/** Closing marker of the trailing generation-stats block. */
export const STATS_CLOSE = '<|/stats|>'

/**
 * Total context the backend enforces, in tokens, measured empirically:
 * a request whose reported `prefill_tokens` reached 6141 with 2 output tokens
 * succeeded, while one needing 6143 + 2 returned a zero-byte body. The site's
 * own client caps at the same number (`NEXT_PUBLIC_TOKEN_LIMIT`, default 6144).
 */
export const CONTEXT_WINDOW = 6144

/** Model the service serves. `/api/models` advertises exactly this one id. */
export const DEFAULT_MODEL = 'llama3.1-8B'

/** Base URL of the deployment. */
export const DEFAULT_BASE_URL = 'https://chatjimmy.ai'

/**
 * Attribution the harness requires on every provider request
 * (`attributionHeaders()` in `@deepseek-ai/dsh-llm`). Reproduced literally
 * because this plugin cannot import the harness package; keep it in step with
 * `APP_IDENTITY` in `packages/llm/llm/src/attribution.ts`.
 */
export const DEFAULT_USER_AGENT = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)'

/** One wire message chatjimmy accepts. */
export interface WireMessage {
  role: 'user' | 'assistant'
  content: string
}

/** The body `POST /api/chat` expects. */
export interface ChatRequestBody {
  messages: WireMessage[]
  chatOptions: {
    selectedModel: string
    systemPrompt: string
    topK: number
  }
  attachment: null
}

/** The stats fields this adapter reads; the payload carries more. */
export interface ChatStats {
  prefill_tokens?: number
  decode_tokens?: number
  total_tokens?: number
  done_reason?: string
  reason?: string
  [key: string]: unknown
}

/** Resolved adapter configuration. */
export interface ChatJimmyConfig {
  baseUrl: string
  model: string
  topK: number
  contextWindow: number
}

/** Flatten a block tree to the plain text the wire can carry. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return typeof block.text === 'string' ? block.text : ''
    case 'tool-call':
      // The service has no tool protocol. Render the call as prose so a
      // cross-provider history still reads as a conversation.
      return `[tool call] ${String(block.name)}(${String(block.arguments)})`
    case 'tool-result':
      return `[tool result] ${flatten((block.content ?? []) as readonly ContentBlock[])}`
    default:
      // Images and files are already projected to text for a text-only route
      // by LlmRuntime; anything else unknown is dropped rather than guessed.
      return ''
  }
}

/** Flatten a block list to plain text. */
export function flatten(blocks: readonly ContentBlock[]): string {
  return blocks.map(blockText).join('')
}

/**
 * Build the exact request body for one model call: history is flattened to
 * text, every system-role message is hoisted into the single `systemPrompt`
 * slot, and the caller's `system` text leads it.
 */
export function buildChatRequest(options: GenerateOptions, config: ChatJimmyConfig): ChatRequestBody {
  const systemParts: string[] = []
  const messages: WireMessage[] = []
  for (const message of options.messages) {
    const text = flatten(message.content)
    if (message.role === 'system') {
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (text.length > 0) messages.push({ role: message.role, content: text })
  }
  if (options.system !== undefined && options.system.length > 0) systemParts.unshift(options.system)
  return {
    messages,
    chatOptions: {
      selectedModel: options.model.length > 0 ? options.model : config.model,
      systemPrompt: systemParts.join('\n\n'),
      topK: config.topK,
    },
    attachment: null,
  }
}

/** Parse the stats payload, returning undefined for malformed JSON. */
export function parseStats(raw: string): ChatStats | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? value as ChatStats : undefined
  } catch {
    return undefined
  }
}

/**
 * True when a stats `reason` reports the backend's own context-limit refusal.
 * @param reason - the stats `reason` field, when present.
 */
export function isContextLimitReason(reason: unknown): boolean {
  return typeof reason === 'string' && /max\s+context\s+limit\s+\d+\s+reached/i.test(reason)
}

/**
 * Map backend token counters onto harness usage.
 * @param stats - parsed stats, when the stream carried them.
 * @returns disjoint harness counts; the provider reports no cache split.
 */
export function mapUsage(stats: ChatStats | undefined): TokenUsage {
  const input = typeof stats?.prefill_tokens === 'number' ? stats.prefill_tokens : 0
  const output = typeof stats?.decode_tokens === 'number' ? stats.decode_tokens : 0
  const total = typeof stats?.total_tokens === 'number' ? stats.total_tokens : input + output
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}

/**
 * Splits the generated text from the trailing `<|stats|>…<|/stats|>` block
 * without ever emitting a partial marker.
 *
 * The backend appends the block to the same byte stream as the completion, so a
 * reader that forwarded chunks verbatim would leak `{"prefill_tokens":…}` into
 * the model's visible answer. Text is held back only as far as a marker could
 * still be forming, so time-to-first-token is unaffected.
 */
export class StatsStreamFilter {
  #buffer = ''
  #stats: ChatStats | undefined
  #closed = false

  /**
   * Absorb one decoded chunk.
   * @param text - newly decoded text.
   * @returns the prefix that is certainly completion text.
   */
  push(text: string): string {
    if (this.#closed || text.length === 0) return ''
    this.#buffer += text
    const open = this.#buffer.indexOf(STATS_OPEN)
    if (open < 0) {
      // No marker yet: hold back only what a split marker could consume.
      const keep = STATS_OPEN.length - 1
      if (this.#buffer.length <= keep) return ''
      const emit = this.#buffer.slice(0, this.#buffer.length - keep)
      this.#buffer = this.#buffer.slice(-keep)
      return emit
    }
    const emit = this.#buffer.slice(0, open)
    const rest = this.#buffer.slice(open)
    const close = rest.indexOf(STATS_CLOSE)
    if (close < 0) {
      this.#buffer = rest
      return emit
    }
    this.#stats = parseStats(rest.slice(STATS_OPEN.length, close))
    this.#buffer = ''
    this.#closed = true
    return emit
  }

  /**
   * Release whatever the stream ended with.
   * @returns residual completion text; empty when the body ended on the marker.
   */
  flush(): string {
    if (this.#closed || this.#buffer.length === 0) return ''
    const emit = this.#buffer
    this.#buffer = ''
    return emit
  }

  /** Stats the stream carried, when the sentinel was complete. */
  get stats(): ChatStats | undefined {
    return this.#stats
  }
}
