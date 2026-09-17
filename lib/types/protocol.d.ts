/**
 * Wire translation between the harness request vocabulary and the
 * chatjimmy.ai HTTP API reconstructed in `API.md`.
 *
 * Everything here is pure so it can be tested without a harness or a network.
 *
 * @module dsh-chatjimmy/protocol
 */
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, TokenUsage } from './host.ts';
/** Opening marker of the trailing generation-stats block. */
export declare const STATS_OPEN = "<|stats|>";
/** Closing marker of the trailing generation-stats block. */
export declare const STATS_CLOSE = "<|/stats|>";
/** One wire message chatjimmy accepts. */
export interface WireMessage {
    role: 'user' | 'assistant';
    content: string;
}
/** The body `POST /api/chat` expects. */
export interface ChatRequestBody {
    messages: WireMessage[];
    chatOptions: {
        selectedModel: string;
        systemPrompt: string;
        topK: number;
    };
    attachment: null;
}
/** The stats fields this adapter reads; the payload carries more. */
export interface ChatStats {
    prefill_tokens?: number;
    decode_tokens?: number;
    total_tokens?: number;
    done_reason?: string;
    reason?: string;
    [key: string]: unknown;
}
/** Resolved adapter configuration. */
export interface ChatJimmyConfig {
    baseUrl: string;
    model: string;
    topK: number;
    contextWindow: number;
    /** Per-read idle watchdog: a stream that produces nothing for this long fails with `TIMEOUT`. */
    streamIdleTimeoutMs: number;
    /**
     * Provider-owned retry policy, reported to the harness at registration. Absent
     * means the harness's own normal defaults.
     */
    retryPolicy?: RetryPolicyConfig;
}
/** Flatten a block list to plain text. */
export declare function flatten(blocks: readonly ContentBlock[]): string;
/**
 * Build the exact request body for one model call: history is flattened to
 * text, every system-role message is hoisted into the single `systemPrompt`
 * slot, and the caller's `system` text leads it.
 */
export declare function buildChatRequest(options: GenerateOptions, config: ChatJimmyConfig): ChatRequestBody;
/** Parse the stats payload, returning undefined for malformed JSON. */
export declare function parseStats(raw: string): ChatStats | undefined;
/**
 * True when a stats `reason` reports the backend's own context-limit refusal.
 * @param reason - the stats `reason` field, when present.
 */
export declare function isContextLimitReason(reason: unknown): boolean;
/**
 * Map backend token counters onto harness usage.
 * @param stats - parsed stats, when the stream carried them.
 * @returns disjoint harness counts; the provider reports no cache split.
 */
export declare function mapUsage(stats: ChatStats | undefined): TokenUsage;
/**
 * Splits the generated text from the trailing `<|stats|>…<|/stats|>` block
 * without ever emitting a partial marker.
 *
 * The backend appends the block to the same byte stream as the completion, so a
 * reader that forwarded chunks verbatim would leak `{"prefill_tokens":…}` into
 * the model's visible answer. Text is held back only as far as a marker could
 * still be forming, so time-to-first-token is unaffected.
 */
export declare class StatsStreamFilter {
    #private;
    /**
     * Absorb one decoded chunk.
     * @param text - newly decoded text.
     * @returns the prefix that is certainly completion text.
     */
    push(text: string): string;
    /**
     * Release whatever the stream ended with.
     * @returns residual completion text; empty when the body ended on the marker.
     */
    flush(): string;
    /** Stats the stream carried, when the sentinel was complete. */
    get stats(): ChatStats | undefined;
}
