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
 * Configuration accepted from this plugin's row in a profile patch.
 *
 * The exported schema is what Cordis validates the row against and fills
 * defaults from; `resolveConfig` then normalizes the validated values.
 */
export interface Config {
    /** Deployment origin. Defaults to `https://chatjimmy.ai`. */
    readonly baseUrl?: string;
    /** Model id sent as `chatOptions.selectedModel`. Defaults to `llama3.1-8B`. */
    readonly model?: string;
    /** Forwarded as `chatOptions.topK`. The site's own client sends 8. */
    readonly topK?: number;
    /**
     * Total context window in tokens used for call-config validation. Measured
     * against the live service at 6144 (prompt + completion).
     */
    readonly contextWindow?: number;
    /**
     * Per-read stream idle watchdog in milliseconds; a stream that produces
     * nothing for this long ends with the `TIMEOUT` failure.
     */
    readonly streamIdleTimeoutMs?: number;
    /**
     * Provider-owned retry policy for this route, in the harness
     * `RetryPolicyConfig` shape (`{ mode: 'normal' | 'always', … }`). Absent
     * leaves the harness's own normal defaults.
     */
    readonly retryPolicy?: RetryPolicyConfig;
}
/** Row schema: defaults live here, so a deployment only states what it changes. */
export declare const Config: Schema<Config>;
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
export declare function resolveConfig(config?: Config): ChatJimmyConfig;
/**
 * Mount the adapter.
 * @param ctx - host context; `ctx.llm` must be mounted (`inject` guarantees it).
 * @param config - this plugin's row configuration.
 */
export declare function apply(ctx: HostContext, config?: Config): void;
