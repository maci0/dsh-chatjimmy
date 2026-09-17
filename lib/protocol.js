/**
 * Wire translation between the harness request vocabulary and the
 * chatjimmy.ai HTTP API reconstructed in `API.md`.
 *
 * Everything here is pure so it can be tested without a harness or a network.
 *
 * @module dsh-chatjimmy/protocol
 */
/** Opening marker of the trailing generation-stats block. */
export const STATS_OPEN = '<|stats|>';
/** Closing marker of the trailing generation-stats block. */
export const STATS_CLOSE = '<|/stats|>';
/** Flatten a block tree to the plain text the wire can carry. */
function blockText(block) {
    switch (block.type) {
        case 'text':
        case 'reasoning':
            return typeof block.text === 'string' ? block.text : '';
        case 'tool-call':
            // The service has no tool protocol. Render the call as prose so a
            // cross-provider history still reads as a conversation.
            return `[tool call] ${String(block.name)}(${String(block.arguments)})`;
        case 'tool-result':
            return `[tool result] ${flatten((block.content ?? []))}`;
        default:
            // Images and files are already projected to text for a text-only route
            // by LlmRuntime; anything else unknown is dropped rather than guessed.
            return '';
    }
}
/** Flatten a block list to plain text. */
export function flatten(blocks) {
    return blocks.map(blockText).join('');
}
/**
 * Build the exact request body for one model call: history is flattened to
 * text, every system-role message is hoisted into the single `systemPrompt`
 * slot, and the caller's `system` text leads it.
 */
export function buildChatRequest(options, config) {
    const systemParts = [];
    const messages = [];
    for (const message of options.messages) {
        const text = flatten(message.content);
        if (message.role === 'system') {
            if (text.length > 0)
                systemParts.push(text);
            continue;
        }
        if (text.length > 0)
            messages.push({ role: message.role, content: text });
    }
    if (options.system !== undefined && options.system.length > 0)
        systemParts.unshift(options.system);
    return {
        messages,
        chatOptions: {
            selectedModel: options.model.length > 0 ? options.model : config.model,
            systemPrompt: systemParts.join('\n\n'),
            topK: config.topK,
        },
        attachment: null,
    };
}
/** Parse the stats payload, returning undefined for malformed JSON. */
export function parseStats(raw) {
    try {
        const value = JSON.parse(raw);
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * True when a stats `reason` reports the backend's own context-limit refusal.
 * @param reason - the stats `reason` field, when present.
 */
export function isContextLimitReason(reason) {
    return typeof reason === 'string' && /max\s+context\s+limit\s+\d+\s+reached/i.test(reason);
}
/**
 * Map backend token counters onto harness usage.
 * @param stats - parsed stats, when the stream carried them.
 * @returns disjoint harness counts; the provider reports no cache split.
 */
export function mapUsage(stats) {
    const input = typeof stats?.prefill_tokens === 'number' ? stats.prefill_tokens : 0;
    const output = typeof stats?.decode_tokens === 'number' ? stats.decode_tokens : 0;
    const total = typeof stats?.total_tokens === 'number' ? stats.total_tokens : input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
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
    #buffer = '';
    #stats;
    #closed = false;
    /**
     * Absorb one decoded chunk.
     * @param text - newly decoded text.
     * @returns the prefix that is certainly completion text.
     */
    push(text) {
        if (this.#closed || text.length === 0)
            return '';
        this.#buffer += text;
        const open = this.#buffer.indexOf(STATS_OPEN);
        if (open < 0) {
            // No marker yet: hold back only what a split marker could consume.
            const keep = STATS_OPEN.length - 1;
            if (this.#buffer.length <= keep)
                return '';
            const emit = this.#buffer.slice(0, this.#buffer.length - keep);
            this.#buffer = this.#buffer.slice(-keep);
            return emit;
        }
        const emit = this.#buffer.slice(0, open);
        const rest = this.#buffer.slice(open);
        const close = rest.indexOf(STATS_CLOSE);
        if (close < 0) {
            this.#buffer = rest;
            return emit;
        }
        this.#stats = parseStats(rest.slice(STATS_OPEN.length, close));
        this.#buffer = '';
        this.#closed = true;
        return emit;
    }
    /**
     * Release whatever the stream ended with.
     * @returns residual completion text; empty when the body ended on the marker.
     */
    flush() {
        if (this.#closed || this.#buffer.length === 0)
            return '';
        const emit = this.#buffer;
        this.#buffer = '';
        return emit;
    }
    /** Stats the stream carried, when the sentinel was complete. */
    get stats() {
        return this.#stats;
    }
}
