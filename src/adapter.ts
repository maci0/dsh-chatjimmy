/**
 * Provider adapter for the chatjimmy.ai chat API (see `API.md` at the
 * repository root for the reconstructed wire contract).
 *
 * The service is text-in/text-out: it accepts no tool schemas, no images, no
 * sampling parameters, and returns one plain-text stream. This adapter is
 * therefore honest about being a text-only route — it advertises
 * `inputModalities: ['text']` so `LlmRuntime` projects files and images to
 * placeholder text before dispatch, and it ignores every tool field rather than
 * pretending the model can call them.
 *
 * @module dsh-chatjimmy/adapter
 */

import {
  buildChatRequest,
  DEFAULT_USER_AGENT,
  isContextLimitReason,
  mapUsage,
  StatsStreamFilter,
  type ChatJimmyConfig,
  type ChatStats,
} from './protocol.ts'
import type {
  FinishReason,
  GenerateOptions,
  LlmAdapterLike,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from './host.ts'

/** Stable failure used when the backend answers with a zero-byte stream body. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

const CONFIGURED_MODEL_DESCRIPTION =
  'Taalas-hosted Llama 3.1 8B served by chatjimmy.ai. Text only: no tool calls, no images, 6144-token total context.'

/** Injectable fetch, so the adapter is testable without a network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/**
 * Maps an HTTP status onto a provider-neutral failure code. The service emits
 * `{"success":false,"error":"…"}` for every rejection, so the body is the
 * actionable part and the status is only the class.
 */
function failureForStatus(status: number, detail: string): LlmFailure {
  const code = status === 400 || status === 422
    ? 'INVALID_REQUEST'
    : status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'TRANSPORT'
  return { message: `chatjimmy: HTTP ${status}${detail.length > 0 ? ` — ${detail}` : ''}`, code, status }
}

/** The one failure the backend's own context-limit refusal produces. */
function contextLimitFailure(reason: unknown): LlmFailure {
  return { message: `chatjimmy: ${String(reason)}`, code: CONTEXT_WINDOW_EXCEEDED_CODE }
}

/** Terminal error finish carrying one failure. */
function errorFinish(failure: LlmFailure): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** Read a failed response body as the service's JSON error envelope. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') return parsed.error
    } catch {
      // Not the JSON envelope; the raw text is all there is.
    }
    return text.slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * Map the stats block's own stop reason onto a harness finish reason.
 * @param stats - parsed stats, when the stream carried them.
 */
export function finishReasonFor(stats: ChatStats | undefined): FinishReason {
  if (isContextLimitReason(stats?.reason)) {
    return { kind: 'error', failure: contextLimitFailure(stats?.reason) }
  }
  if (stats?.done_reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Duck-typed adapter over `POST /api/chat`.
 *
 * `LlmRuntime` reaches adapters through plain method calls, so this object
 * needs no harness base class and the plugin keeps zero runtime dependency on
 * `@deepseek-ai/*` — the same posture as the other plugins under
 * `~/dsh-plugins`.
 */
export class ChatJimmyAdapter implements LlmAdapterLike {
  readonly #config: ChatJimmyConfig
  readonly #fetch: FetchLike

  /**
   * @param config - the resolved configuration this adapter serves.
   * @param fetchImpl - transport override for tests.
   */
  constructor(config: ChatJimmyConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.#config = config
    this.#fetch = fetchImpl
  }

  /** {@inheritDoc LlmAdapterLike.providerInfo} */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Chat Jimmy (Taalas)' }
  }

  /**
   * No provider-owned retry policy: the service is stateless and fast, so the
   * harness defaults are right.
   *
   * This and {@link imageRequestPricing} exist because `LlmRuntime` calls them
   * on every dispatch. A harness `LlmAdapter` subclass inherits them; a
   * duck-typed adapter must supply them or the very first registration throws
   * `adapter.providerRetryPolicy is not a function`.
   */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** No route charges visual tokens: this adapter is text-only. */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /**
   * The advertised catalog. `/api/models` serves exactly one entry, so it is
   * mirrored from configuration instead of costing a round trip on every model
   * picker open. The id stays advisory: any id is accepted on the wire.
   */
  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: this.#config.model,
      name: 'Llama 3.1 8B (Chat Jimmy)',
      description: CONFIGURED_MODEL_DESCRIPTION,
      inputModalities: ['text'],
    }])
  }

  /** {@inheritDoc LlmAdapterLike.resolveModel} */
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model === this.#config.model ? 'Llama 3.1 8B (Chat Jimmy)' : model,
      description: CONFIGURED_MODEL_DESCRIPTION,
      inputModalities: ['text'],
      context: { contextWindow: this.#config.contextWindow },
    })
  }

  /** {@inheritDoc LlmAdapterLike.prepareCall} */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * Stream one completion. Everything the service sends is completion text up
   * to the trailing stats block, which {@link StatsStreamFilter} removes; the
   * block is then reported as harness usage.
   *
   * A zero-byte body with HTTP 200 is the service's signature for a request
   * that overflowed the context window: the response headers are already
   * committed as `text/event-stream`, so the backend's refusal cannot be
   * delivered as an error status. That case is reported as
   * `CONTEXT_WINDOW_EXCEEDED` rather than as an empty completion.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': DEFAULT_USER_AGENT,
    }

    let response: Response
    try {
      response = await this.#fetch(`${this.#config.baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildChatRequest(options, this.#config)),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield errorFinish({ message: 'chatjimmy: request aborted', code: 'ABORTED' })
        return
      }
      yield errorFinish({
        message: `chatjimmy: ${error instanceof Error ? error.message : String(error)}`,
        code: 'TRANSPORT',
      })
      return
    }

    if (!response.ok) {
      yield errorFinish(failureForStatus(response.status, await errorDetail(response)))
      return
    }
    if (response.body === null) {
      yield errorFinish({ message: 'chatjimmy: response carried no body', code: 'TRANSPORT' })
      return
    }

    const filter = new StatsStreamFilter()
    const decoder = new TextDecoder()
    // The block is opened lazily: a stream that yields no text must not
    // publish an empty text block.
    const index = 0
    let open = false
    let assembled = ''

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const text = filter.push(decoder.decode(chunk, { stream: true }))
        if (text.length === 0) continue
        if (!open) {
          yield { type: 'block-start', index, blockType: 'text' }
          open = true
        }
        assembled += text
        yield { type: 'text-delta', index, text }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield errorFinish({ message: 'chatjimmy: request aborted', code: 'ABORTED' })
        return
      }
      yield errorFinish({
        message: `chatjimmy: stream ended abnormally — ${error instanceof Error ? error.message : String(error)}`,
        code: 'TRANSPORT',
      })
      return
    }

    const tail = filter.push(decoder.decode()) + filter.flush()
    if (tail.length > 0) {
      if (!open) {
        yield { type: 'block-start', index, blockType: 'text' }
        open = true
      }
      assembled += tail
      yield { type: 'text-delta', index, text: tail }
    }

    const stats = filter.stats
    if (!open) {
      yield emptyStreamFinish(stats, this.#config.contextWindow)
      return
    }
    yield { type: 'block-end', index, block: { type: 'text', text: assembled } }
    yield { type: 'usage', usage: mapUsage(stats) }
    yield { type: 'finish', reason: finishReasonFor(stats) }
  }
}

/**
 * Classify a stream that produced no text at all.
 * @param stats - stats the stream carried, if any.
 * @param contextWindow - capacity reported to the harness, named in the message.
 * @returns the terminal failure chunk.
 */
function emptyStreamFinish(stats: ChatStats | undefined, contextWindow: number): StreamChunk {
  if (stats !== undefined) {
    return isContextLimitReason(stats.reason)
      ? errorFinish(contextLimitFailure(stats.reason))
      : errorFinish({
          message: `chatjimmy: the model returned a completed response with no content`
            + ` (reason: ${String(stats.reason ?? 'unknown')})`,
          code: 'EMPTY_RESPONSE',
        })
  }
  return errorFinish({
    message: `chatjimmy: the backend returned an empty stream. This is its signature for a request that overflowed`
      + ` the ${contextWindow}-token total context (prompt + completion); shorten the conversation and retry.`,
    code: CONTEXT_WINDOW_EXCEEDED_CODE,
  })
}
