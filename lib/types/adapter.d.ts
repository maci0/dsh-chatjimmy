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
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import { type ChatJimmyConfig } from './protocol.ts';
import type { GenerateOptions, LlmAdapterLike, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from './host.ts';
/** Stable failure used when the backend answers with a zero-byte stream body. */
export { CONTEXT_WINDOW_EXCEEDED_CODE };
/** Injectable fetch, so the adapter is testable without a network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
/**
 * Duck-typed adapter over `POST /api/chat`.
 *
 * `LlmRuntime` reaches adapters through plain method calls, so this object
 * needs no harness base class. The plugin's only runtime dependency on
 * `@deepseek-ai/*` is `@deepseek-ai/dsh-llm`'s pure helpers —
 * `attributionHeaders()` and `resolveRetryPolicy()` — never its error classes
 * or adapter base class.
 */
export declare class ChatJimmyAdapter implements LlmAdapterLike {
    #private;
    /**
     * @param config - the resolved configuration this adapter serves, or a
     * provider that resolves it on every read. The plugin passes the live
     * provider, so a settings edit (the Plugins card, `/alias`-style patch
     * writes) reaches the next request without remounting the adapter; a plain
     * value keeps the snapshot behavior for direct callers and tests.
     * @param fetchImpl - transport override for tests.
     */
    constructor(config: ChatJimmyConfig | (() => ChatJimmyConfig), fetchImpl?: FetchLike);
    /** {@inheritDoc LlmAdapterLike.providerInfo} */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * The provider-owned retry policy from configuration, already resolved, or
     * `undefined` to leave the harness's normal defaults in place.
     *
     * This and {@link imageRequestPricing} exist because `LlmRuntime` calls them
     * on every dispatch. A harness `LlmAdapter` subclass inherits them; a
     * duck-typed adapter must supply them or the very first registration throws
     * `adapter.providerRetryPolicy is not a function`.
     */
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    /** No route charges visual tokens: this adapter is text-only. */
    imageRequestPricing(_provider: string, _model: string): undefined;
    /**
     * The advertised catalog. `/api/models` serves exactly one entry, so it is
     * mirrored from configuration instead of costing a round trip on every model
     * picker open. The id stays advisory: any id is accepted on the wire.
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    /** {@inheritDoc LlmAdapterLike.resolveModel} */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** {@inheritDoc LlmAdapterLike.prepareCall} */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
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
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
