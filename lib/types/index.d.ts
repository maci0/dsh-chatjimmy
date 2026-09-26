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
import type { Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { ChatJimmyConfig } from './protocol.ts';
import type { HostContext } from './host.ts';
/** Plugin name as it appears in the loader. */
export declare const name = "chatjimmy";
/** The `ctx.llm` provider route this adapter owns. */
export declare const PROVIDER = "chatjimmy";
/** The one service this plugin needs mounted. */
export declare const inject: string[];
/**
 * Configuration this plugin's row resolves to, as `apply` receives it.
 *
 * Every field a user may edit is `volatile()`, and the loader hands a volatile
 * field a live reference rather than a value — the schema's own output type,
 * `Volatile<T>`. Reading `.get()` at use time is what makes an edit from the
 * Plugins card reach the next request without remounting the route.
 */
export interface Config {
    /** Deployment origin. Defaults to `https://chatjimmy.ai`. Volatile: editable from the Plugins card. */
    readonly baseUrl: Volatile<string>;
    /** Model id sent as `chatOptions.selectedModel`. Defaults to `llama3.1-8B`. Volatile. */
    readonly model: Volatile<string>;
    /** Forwarded as `chatOptions.topK`. The site's own client sends 8. Volatile. */
    readonly topK: Volatile<number>;
    /**
     * Total context window in tokens used for call-config validation. Measured
     * against the live service at 6144 (prompt + completion). Volatile.
     */
    readonly contextWindow: Volatile<number>;
    /**
     * Per-read stream idle watchdog in milliseconds; a stream that produces
     * nothing for this long ends with the `TIMEOUT` failure. Volatile.
     */
    readonly streamIdleTimeoutMs: Volatile<number>;
    /**
     * Provider-owned retry policy for this route, in the harness
     * `RetryPolicyConfig` shape (`{ mode: 'normal' | 'always', … }`). Absent
     * leaves the harness's own normal defaults. Patch-only: a policy is an
     * operator's decision, not a form field.
     */
    readonly retryPolicy?: RetryPolicyConfig;
}
/** Raw row values, as a profile patch states them and as tests pass them. */
export type Options = {
    [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : Config[K];
};
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
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    baseUrl: Schema<string, string, "volatile-defined">;
    model: Schema<string, string, "volatile-defined">;
    topK: Schema<number, number, "volatile-defined">;
    contextWindow: Schema<number, number, "volatile-defined">;
    streamIdleTimeoutMs: Schema<number, number, "volatile-defined">;
    retryPolicy: Schema<RetryPolicyConfig>;
}>>, Schemastery.ObjectT<NoInfer<{
    baseUrl: Schema<string, string, "volatile-defined">;
    model: Schema<string, string, "volatile-defined">;
    topK: Schema<number, number, "volatile-defined">;
    contextWindow: Schema<number, number, "volatile-defined">;
    streamIdleTimeoutMs: Schema<number, number, "volatile-defined">;
    retryPolicy: Schema<RetryPolicyConfig>;
}>>, "plain">;
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
export declare function resolveConfig(config?: Options): ChatJimmyConfig;
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
export declare function liveOptions(config: Config): Options;
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
export declare function apply(ctx: HostContext, config: Config): void;
