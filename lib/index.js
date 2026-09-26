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
/** Plugin name as it appears in the loader. */
export const name = 'chatjimmy';
/** The `ctx.llm` provider route this adapter owns. */
export const PROVIDER = 'chatjimmy';
/** The one service this plugin needs mounted. */
export const inject = ['llm'];
/**
 * Total context the backend enforces, in tokens, measured empirically:
 * a request whose reported `prefill_tokens` reached 6141 with 2 output tokens
 * succeeded, while one needing 6143 + 2 returned a zero-byte body. The site's
 * own client caps at the same number (`NEXT_PUBLIC_TOKEN_LIMIT`, default 6144).
 */
const CONTEXT_WINDOW = 6144;
/** Model the service serves. `/api/models` advertises exactly this one id. */
const DEFAULT_MODEL = 'llama3.1-8B';
/** Base URL of the deployment. */
const DEFAULT_BASE_URL = 'https://chatjimmy.ai';
/** Per-read stream idle watchdog default, matching the shipped remote adapters. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** `setTimeout`'s maximum delay; a larger configured timeout is rejected at load. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Field defaults and bounds with no volatility wrapper.
 *
 * {@link resolveConfig} parses a plain row through this schema, so its output
 * is plain values; the loader-facing {@link Config} below is the same shape
 * with every editable field made `volatile()`, which is what hands the plugin
 * a live reference. The pair is asserted equal in the suite.
 */
const ValueSchema = Schema.object({
    baseUrl: Schema.string().default(DEFAULT_BASE_URL),
    model: Schema.string().default(DEFAULT_MODEL),
    topK: Schema.number().step(1).min(1).default(8),
    contextWindow: Schema.number().step(1).min(1).default(CONTEXT_WINDOW),
    streamIdleTimeoutMs: Schema.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
        .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    retryPolicy: RetryPolicySchema,
});
/**
 * Row schema as Cordis resolves it: defaults live here, so a deployment only
 * states what it changes.
 *
 * Every field a user may edit is `volatile()` — the settings document accepts
 * only volatile paths, and the browser half's card edits exactly these. The
 * adapter resolves the row per read, so an edit lands on the next request
 * instead of waiting for a remount. `retryPolicy` stays ordinary
 * configuration: patch-only, as its docs say.
 */
export const Config = Schema.object({
    baseUrl: Schema.string().default(DEFAULT_BASE_URL).volatile(),
    model: Schema.string().default(DEFAULT_MODEL).volatile(),
    topK: Schema.number().step(1).min(1).default(8).volatile(),
    contextWindow: Schema.number().step(1).min(1).default(CONTEXT_WINDOW).volatile(),
    streamIdleTimeoutMs: Schema.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
        .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
    retryPolicy: RetryPolicySchema,
});
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
export function resolveConfig(config = {}) {
    const resolved = ValueSchema(config);
    const baseUrl = resolved.baseUrl.replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(baseUrl);
    }
    catch {
        throw new Error(`chatjimmy: baseUrl "${resolved.baseUrl}" is not a valid absolute URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`chatjimmy: baseUrl "${resolved.baseUrl}" must use http or https`);
    }
    // Any string is a valid model id to the schema, but the empty one is not a model.
    if (resolved.model.trim().length === 0)
        throw new Error('chatjimmy: model must be a non-empty string');
    // `min`/`max` cannot see NaN (every comparison against it is false, so NaN
    // passes both), and schemastery has no refinement hook. One explicit check.
    for (const field of ['topK', 'contextWindow', 'streamIdleTimeoutMs']) {
        if (!Number.isFinite(resolved[field])) {
            throw new Error(`chatjimmy: ${field} must be a finite number, got ${String(resolved[field])}`);
        }
    }
    return { ...resolved, baseUrl };
}
/**
 * Read the live row out of the references the loader resolved.
 *
 * Every editable field arrives as a `Volatile<T>`; this is the one place that
 * turns them back into the plain values the schema and the adapter understand,
 * so a caller cannot forget one.
 *
 * @param config - the resolved row.
 * @returns plain row values, with absent references left undefined.
 */
export function liveOptions(config) {
    return {
        baseUrl: config.baseUrl.get(),
        model: config.model.get(),
        topK: config.topK.get(),
        contextWindow: config.contextWindow.get(),
        streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
        retryPolicy: config.retryPolicy,
    };
}
/**
 * Mount the adapter.
 *
 * The adapter is handed the resolver itself, not one resolved row: every
 * configurable field is `volatile()`, so a settings write from the Plugins
 * card changes what the next request uses without remounting the provider
 * route (which would drop the model picker's selection). The row is resolved
 * once here anyway, so an unusable one still fails at mount the way a
 * non-volatile row would.
 *
 * @param ctx - host context; `ctx.llm` must be mounted (`inject` guarantees it).
 * @param config - this plugin's row configuration.
 */
export function apply(ctx, config) {
    const live = () => resolveConfig(liveOptions(config));
    const resolved = live();
    ctx.llm.registerAdapter([PROVIDER], new ChatJimmyAdapter(live));
    ctx.logger.info(`chatjimmy: provider "${PROVIDER}" registered for model "${resolved.model}" at ${resolved.baseUrl}`
        + ` (text only, ${resolved.contextWindow}-token total context)`);
    // Report edits rather than swallowing them: a card write that made the row
    // unusable has to be visible somewhere, and this is the only surface the
    // host owns. The value stays on the row, so the request that needs it will
    // raise the same error with the same message.
    ctx.on('loader/volatile-update', () => {
        try {
            const next = live();
            ctx.logger.info(`chatjimmy: configuration updated — model "${next.model}" at ${next.baseUrl}`
                + `, topK ${String(next.topK)}, ${next.contextWindow}-token context`);
        }
        catch (error) {
            ctx.logger.warn(`chatjimmy: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
