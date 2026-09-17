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
export {};
