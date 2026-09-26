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
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { buildChatRequest, isContextLimitReason, mapUsage, StatsStreamFilter, } from './protocol.js';
/** Stable failure used when the backend answers with a zero-byte stream body. */
export { CONTEXT_WINDOW_EXCEEDED_CODE };
/**
 * Metadata every appearance of the configured model carries: the backend serves
 * one model, so its wording and modalities live here rather than in two object
 * literals.
 */
const CONFIGURED_MODEL = {
    name: 'Llama 3.1 8B (Chat Jimmy)',
    description: 'Taalas-hosted Llama 3.1 8B served by chatjimmy.ai.'
        + ' Text only: no tool calls, no images, 6144-token total context.',
    inputModalities: ['text'],
};
/**
 * Maps an HTTP status onto a provider-neutral failure code. The service emits
 * `{"success":false,"error":"…"}` for every rejection, so the body is the
 * actionable part and the status is only the class.
 */
function failureForStatus(status, detail) {
    const code = status === 400 || status === 422
        ? 'INVALID_REQUEST'
        : status === 401 || status === 403
            ? 'AUTH'
            : status === 429
                ? 'RATE_LIMIT'
                : status >= 500
                    ? 'SERVER'
                    : 'TRANSPORT';
    return { message: `chatjimmy: HTTP ${status}${detail.length > 0 ? ` — ${detail}` : ''}`, code, status };
}
/** The one failure the backend's own context-limit refusal produces. */
function contextLimitFailure(reason) {
    return { message: `chatjimmy: ${String(reason)}`, code: CONTEXT_WINDOW_EXCEEDED_CODE };
}
/** Terminal error finish carrying one failure. */
function errorFinish(failure) {
    return { type: 'finish', reason: { kind: 'error', failure } };
}
/**
 * Terminal abort finish. Caller cancellation is not a provider failure, so it
 * uses the `aborted` reason the protocol reserves for it.
 */
function abortFinish() {
    return { type: 'finish', reason: { kind: 'aborted', failure: { message: 'chatjimmy: request aborted by caller', code: 'ABORTED' } } };
}
/**
 * A `GenerateOptions` field the service has no wire slot for. Stop sequences
 * change generation semantics, so they are refused rather than dropped; the
 * text-only capability limits (tools, temperature, maxTokens) stay documented
 * in `README.md` and are ignored, since every agent request carries tools.
 * @param options - the request being prepared.
 * @returns the failure to end the stream with, or `undefined` when the request is servable.
 */
function unsupportedOptionFailure(options) {
    if (options.stop !== undefined && options.stop.length > 0) {
        return {
            message: 'chatjimmy accepts no stop sequences; remove the stop list or use a route that supports it',
            code: 'UNSUPPORTED_OPTION',
        };
    }
    return undefined;
}
/** Read a failed response body as the service's JSON error envelope. */
async function errorDetail(response) {
    try {
        const text = await response.text();
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed.error === 'string')
                return parsed.error;
        }
        catch {
            // Not the JSON envelope; the raw text is all there is.
        }
        return text.slice(0, 300);
    }
    catch {
        return '';
    }
}
/**
 * Map the stats block's own stop reason onto a harness finish reason.
 * @param stats - parsed stats, when the stream carried them.
 */
function finishReasonFor(stats) {
    if (isContextLimitReason(stats?.reason)) {
        return { kind: 'error', failure: contextLimitFailure(stats?.reason) };
    }
    if (stats?.done_reason === 'length')
        return { kind: 'max-tokens' };
    return { kind: 'stop' };
}
/**
 * Duck-typed adapter over `POST /api/chat`.
 *
 * `LlmRuntime` reaches adapters through plain method calls, so this object
 * needs no harness base class. The plugin's only runtime dependency on
 * `@deepseek-ai/*` is `@deepseek-ai/dsh-llm`'s pure helpers —
 * `attributionHeaders()` and `resolveRetryPolicy()` — never its error classes
 * or adapter base class.
 */
export class ChatJimmyAdapter {
    #options;
    #fetch;
    /**
     * @param config - the resolved configuration this adapter serves, or a
     * provider that resolves it on every read. The plugin passes the live
     * provider, so a settings edit (the Plugins card, `/alias`-style patch
     * writes) reaches the next request without remounting the adapter; a plain
     * value keeps the snapshot behavior for direct callers and tests.
     * @param fetchImpl - transport override for tests.
     */
    constructor(config, fetchImpl = globalThis.fetch) {
        this.#options = typeof config === 'function' ? config : () => config;
        this.#fetch = fetchImpl;
    }
    /**
     * The configuration as it stands for this read. Resolving per access is what
     * makes a live settings edit observable; `resolveConfig` is pure and cheap,
     * and a read that cannot be resolved throws the same loud error the loader
     * would have raised at mount.
     */
    get #config() {
        return this.#options();
    }
    /** {@inheritDoc LlmAdapterLike.providerInfo} */
    providerInfo(provider) {
        return { id: provider, name: 'Chat Jimmy (Taalas)' };
    }
    /**
     * The provider-owned retry policy from configuration, already resolved, or
     * `undefined` to leave the harness's normal defaults in place.
     *
     * This and {@link imageRequestPricing} exist because `LlmRuntime` calls them
     * on every dispatch. A harness `LlmAdapter` subclass inherits them; a
     * duck-typed adapter must supply them or the very first registration throws
     * `adapter.providerRetryPolicy is not a function`.
     */
    providerRetryPolicy(_provider) {
        const policy = this.#config.retryPolicy;
        return policy === undefined ? undefined : resolveRetryPolicy(policy, 'chatjimmy: retryPolicy');
    }
    /** No route charges visual tokens: this adapter is text-only. */
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    /**
     * The advertised catalog. `/api/models` serves exactly one entry, so it is
     * mirrored from configuration instead of costing a round trip on every model
     * picker open. The id stays advisory: any id is accepted on the wire.
     */
    listModels(provider) {
        return Promise.resolve([{ provider, id: this.#config.model, ...CONFIGURED_MODEL }]);
    }
    /** {@inheritDoc LlmAdapterLike.resolveModel} */
    resolveModel(provider, model, _signal) {
        return Promise.resolve({
            provider,
            id: model,
            ...CONFIGURED_MODEL,
            name: model === this.#config.model ? CONFIGURED_MODEL.name : model,
            context: { contextWindow: this.#config.contextWindow },
        });
    }
    /** {@inheritDoc LlmAdapterLike.prepareCall} */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
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
    async *stream(options) {
        const unsupported = unsupportedOptionFailure(options);
        if (unsupported !== undefined) {
            yield errorFinish(unsupported);
            return;
        }
        // The idle watchdog owns its own controller so a stalled body read can be
        // torn down; the caller's signal is combined with it when present.
        const consumer = new AbortController();
        const signal = options.signal === undefined
            ? consumer.signal
            : AbortSignal.any([options.signal, consumer.signal]);
        let idleTimedOut = false;
        let idleTimer;
        /** True while the stream is expected to produce something. */
        let idleWatching = false;
        let idleStartedAt = 0;
        const idleTimeoutMs = this.#config.streamIdleTimeoutMs;
        /**
         * One timer wakes when the wait it covers would have outlived the bound and
         * re-arms itself for the remainder otherwise, so a stream costs one timer
         * instead of a `setTimeout`/`clearTimeout` pair per transport read.
         */
        const checkIdle = () => {
            idleTimer = undefined;
            // Nothing outstanding: leave the timer unarmed; the next arm creates one.
            if (!idleWatching)
                return;
            const elapsed = performance.now() - idleStartedAt;
            if (elapsed >= idleTimeoutMs) {
                idleTimedOut = true;
                consumer.abort('chatjimmy: stream idle timeout');
                return;
            }
            // The wake-up preceded the wait it covers: sleep the remainder.
            idleTimer = setTimeout(checkIdle, idleTimeoutMs - elapsed);
        };
        const armIdle = () => {
            idleWatching = true;
            idleStartedAt = performance.now();
            idleTimer ??= setTimeout(checkIdle, idleTimeoutMs);
        };
        /** No read or chunk is outstanding any more: leave no timer behind. */
        const disarmIdle = () => {
            idleWatching = false;
            if (idleTimer !== undefined)
                clearTimeout(idleTimer);
            idleTimer = undefined;
        };
        const headers = {
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...attributionHeaders(),
        };
        let response;
        armIdle();
        try {
            response = await this.#fetch(`${this.#config.baseUrl}/api/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify(buildChatRequest(options, this.#config)),
                signal,
            });
        }
        catch (error) {
            if (idleTimedOut) {
                yield errorFinish(idleTimeoutFailure(this.#config.streamIdleTimeoutMs));
                return;
            }
            if (options.signal?.aborted === true) {
                yield abortFinish();
                return;
            }
            yield errorFinish({
                message: `chatjimmy: ${error instanceof Error ? error.message : String(error)}`,
                code: 'TRANSPORT',
            });
            return;
        }
        finally {
            disarmIdle();
        }
        if (!response.ok) {
            yield errorFinish(failureForStatus(response.status, await errorDetail(response)));
            return;
        }
        if (response.body === null) {
            yield errorFinish({ message: 'chatjimmy: response carried no body', code: 'TRANSPORT' });
            return;
        }
        const filter = new StatsStreamFilter();
        const decoder = new TextDecoder();
        // The block is opened lazily: a stream that yields no text must not
        // publish an empty text block.
        const index = 0;
        let open = false;
        let assembled = '';
        try {
            armIdle();
            for await (const chunk of response.body) {
                armIdle();
                const text = filter.push(decoder.decode(chunk, { stream: true }));
                if (text.length === 0)
                    continue;
                if (!open) {
                    yield { type: 'block-start', index, blockType: 'text' };
                    open = true;
                }
                assembled += text;
                yield { type: 'text-delta', index, text };
            }
        }
        catch (error) {
            if (idleTimedOut) {
                yield errorFinish(idleTimeoutFailure(this.#config.streamIdleTimeoutMs));
                return;
            }
            if (options.signal?.aborted === true) {
                yield abortFinish();
                return;
            }
            yield errorFinish({
                message: `chatjimmy: stream ended abnormally — ${error instanceof Error ? error.message : String(error)}`,
                code: 'TRANSPORT',
            });
            return;
        }
        finally {
            disarmIdle();
        }
        const tail = filter.push(decoder.decode()) + filter.flush();
        if (tail.length > 0) {
            if (!open) {
                yield { type: 'block-start', index, blockType: 'text' };
                open = true;
            }
            assembled += tail;
            yield { type: 'text-delta', index, text: tail };
        }
        const stats = filter.stats;
        if (!open) {
            yield emptyStreamFinish(stats, this.#config.contextWindow);
            return;
        }
        yield { type: 'block-end', index, block: { type: 'text', text: assembled } };
        // Usage is reported only when the provider reported it; a synthesized zero
        // would claim a measurement that never happened.
        if (stats !== undefined)
            yield { type: 'usage', usage: mapUsage(stats) };
        yield { type: 'finish', reason: finishReasonFor(stats) };
    }
}
/**
 * The failure for a stream that produced nothing within the configured bound.
 * @param idleTimeoutMs - the configured per-read bound.
 * @returns the terminal failure, coded `TIMEOUT`.
 */
function idleTimeoutFailure(idleTimeoutMs) {
    return {
        message: `chatjimmy: no stream data for ${idleTimeoutMs}ms (streamIdleTimeoutMs); the request was abandoned`,
        code: 'TIMEOUT',
    };
}
/**
 * Classify a stream that produced no text at all.
 *
 * The stats block is classified once, by {@link finishReasonFor}: a stream that
 * carries the backend's context-limit reason ends as that failure, a completed
 * one is an `EMPTY_RESPONSE`. Only a stream with no stats at all falls back to
 * the zero-byte overflow signature.
 *
 * @param stats - stats the stream carried, if any.
 * @param contextWindow - capacity reported to the harness, named in the message.
 * @returns the terminal failure chunk.
 */
function emptyStreamFinish(stats, contextWindow) {
    if (stats === undefined) {
        return errorFinish({
            message: `chatjimmy: the backend returned an empty stream. This is its signature for a request that overflowed`
                + ` the ${contextWindow}-token total context (prompt + completion); shorten the conversation and retry.`,
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
        });
    }
    const reason = finishReasonFor(stats);
    if (reason.kind === 'error')
        return errorFinish(reason.failure);
    return errorFinish({
        message: `chatjimmy: the model returned a completed response with no content`
            + ` (reason: ${String(stats.reason ?? 'unknown')})`,
        code: 'EMPTY_RESPONSE',
    });
}
