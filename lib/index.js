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
import Schema from '@deepseek-ai/schemastery';
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { ChatJimmyAdapter } from './adapter.js';
import { CONTEXT_WINDOW, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_STREAM_IDLE_TIMEOUT_MS, MAX_TIMER_DELAY_MS, } from './protocol.js';
/** Plugin name as it appears in the loader. */
export const name = 'chatjimmy';
/** The `ctx.llm` provider route this adapter owns. */
export const PROVIDER = 'chatjimmy';
/** The one service this plugin needs mounted. */
export const inject = ['llm'];
/** Row schema: defaults live here, so a deployment only states what it changes. */
export const Config = Schema.object({
    baseUrl: Schema.string().default(DEFAULT_BASE_URL),
    model: Schema.string().default(DEFAULT_MODEL),
    topK: Schema.number().step(1).min(1).default(8),
    contextWindow: Schema.number().step(1).min(1).default(CONTEXT_WINDOW),
    streamIdleTimeoutMs: Schema.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    retryPolicy: RetryPolicySchema,
});
/**
 * Validate and normalize one configuration row.
 *
 * Invalid values throw rather than being silently defaulted: a typo'd base URL
 * would otherwise present as an opaque transport failure on the first message.
 *
 * @param config - raw row configuration.
 * @returns the resolved adapter configuration.
 */
export function resolveConfig(config = {}) {
    const rawBase = config.baseUrl ?? DEFAULT_BASE_URL;
    const baseUrl = rawBase.replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        throw new Error(`chatjimmy: baseUrl "${rawBase}" is not a valid absolute URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`chatjimmy: baseUrl "${rawBase}" must use http or https`);
    }
    const model = config.model ?? DEFAULT_MODEL;
    if (model.trim().length === 0)
        throw new Error('chatjimmy: model must be a non-empty string');
    const topK = config.topK ?? 8;
    if (!Number.isInteger(topK) || topK < 1)
        throw new Error(`chatjimmy: topK must be a positive integer, got ${String(config.topK)}`);
    const contextWindow = config.contextWindow ?? CONTEXT_WINDOW;
    if (!Number.isInteger(contextWindow) || contextWindow < 1) {
        throw new Error(`chatjimmy: contextWindow must be a positive integer, got ${String(config.contextWindow)}`);
    }
    const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`chatjimmy: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS},`
            + ` got ${String(config.streamIdleTimeoutMs)}`);
    }
    return {
        baseUrl,
        model,
        topK,
        contextWindow,
        streamIdleTimeoutMs,
        ...config.retryPolicy === undefined ? {} : { retryPolicy: config.retryPolicy },
    };
}
/**
 * Mount the adapter.
 * @param ctx - host context; `ctx.llm` must be mounted (`inject` guarantees it).
 * @param config - this plugin's row configuration.
 */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    ctx.llm.registerAdapter([PROVIDER], new ChatJimmyAdapter(resolved));
    ctx.logger.info(`chatjimmy: provider "${PROVIDER}" registered for model "${resolved.model}" at ${resolved.baseUrl}`
        + ` (text only, ${resolved.contextWindow}-token total context)`);
}
