/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * Like the other plugins under `~/dsh-plugins`, this package declares the host
 * surface it consumes rather than depending on the harness's own classes: its
 * one runtime `@deepseek-ai/*` dependency is `@deepseek-ai/dsh-llm`'s pure
 * `attributionHeaders()` / `resolveRetryPolicy()` helpers. The harness reaches
 * its adapters through plain method calls on the registered object — there is
 * no `instanceof LlmAdapter` check anywhere in `LlmRuntime` — so a duck-typed
 * adapter is a supported shape, not a workaround.
 *
 * Each declaration here is deliberately narrowed to what this adapter reads or
 * emits. Mirroring a foreign API in full is not documentation: a field we never
 * touch is a field whose absence goes unnoticed, which is how the missing
 * `providerRetryPolicy` reached an integration test instead of a compiler.
 * Widen a declaration when the adapter starts using it, not before.
 *
 * @module dsh-chatjimmy/host
 */

/** Disposer returned by every host registration. */
type Disposable = () => void

/** Content block the harness may hand us in request history. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'tool-result'; readonly toolCallId: string; readonly content: readonly ContentBlock[] }
  | { readonly type: string; readonly [key: string]: unknown }

/** One message in a fully-assembled request. */
interface Message {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly ContentBlock[]
}

/** A single model request, narrowed to the fields this adapter reads. */
export interface GenerateOptions {
  readonly model: string
  readonly messages: readonly Message[]
  readonly system?: string
  /**
   * Stop sequences. The service has no wire slot for them, so the adapter
   * refuses a request that sets any (`UNSUPPORTED_OPTION`) instead of
   * generating past where the caller asked it to stop. Tool schemas,
   * `temperature`, and `maxTokens` are declared capability limits in
   * `README.md` and stay dropped.
   */
  readonly stop?: readonly string[]
  readonly signal?: AbortSignal
}

/** Token accounting for one model call. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

/** Stable provider-neutral failure shape. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** Why a model response stopped. */
export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'error'; readonly failure: LlmFailure }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }

/** The two chunk shapes this adapter emits, plus the terminal pair. */
export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: FinishReason }

/** Display metadata for one adapter-owned provider route. */
export interface LlmProviderInfo {
  readonly id: string
  readonly name: string
}

/** One adapter-advertised model. */
export interface LlmModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly string[]
}

/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  readonly context?: { readonly contextWindow: number }
}

/** What `prepareCall` binds: exact model metadata plus one-generation dispatch. */
export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  readonly stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

/**
 * The adapter face `ctx.llm.registerAdapter()` consumes. Every member is called
 * by the harness at runtime; nothing about the object must be a harness class.
 *
 * The list is the full public surface of the harness `LlmAdapter` base class,
 * including the members that only have defaults there. `LlmRuntime` reads
 * `providerRetryPolicy` while registering the adapter and `imageRequestPricing`
 * during a token-meter measurement, so a duck-typed adapter that omits either
 * throws instead of falling back to the base-class default.
 */
export interface LlmAdapterLike {
  providerInfo(provider: string): LlmProviderInfo
  providerRetryPolicy(provider: string): unknown
  imageRequestPricing(provider: string, model: string): unknown
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** The `ctx.llm` seam, narrowed to the one call this plugin makes. */
interface LlmServiceLike {
  registerAdapter(providers: string[], adapter: LlmAdapterLike): Disposable
}

/** The host context slice this plugin touches. */
export interface HostContext {
  readonly llm: LlmServiceLike
  readonly logger: {
    info(message: unknown): void
  }
}
