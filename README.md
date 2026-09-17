# dsh-chatjimmy

**The [chatjimmy.ai](https://chatjimmy.ai/) model as a DeepSeek Harness provider.**

| Capability | Extension point | Effect |
|---|---|---|
| `chatjimmy` provider route | `ctx.llm.registerAdapter(['chatjimmy'], adapter)` | The route appears in the Web client's model picker with model `llama3.1-8B`. |
| Context window | `resolveModel().context.contextWindow` | Reports **6144** tokens, so the harness measures and compacts against the real ceiling. |
| Streaming | `stream()` | Strips the trailing `<\|stats\|>…<\|/stats\|>` block and reports it as harness usage. |
| Overflow classification | `stream()` | The service's zero-byte-200 refusal becomes a `CONTEXT_WINDOW_EXCEEDED` failure, not an empty answer. |

The wire contract this adapter implements is reverse engineered and documented
in [`API.md`](API.md) — three endpoints, `GET /api/health`, `GET /api/models`,
`POST /api/chat`.

## Context window: 6144 tokens

Measured against the live service, not read from a header. The backend reports
`prefill_tokens` per request, which makes the ceiling directly observable:

| prompt `prefill_tokens` | output | result |
|---|---|---|
| 6032 | 63 | 200, full answer |
| 6139 | 2 | 200, full answer |
| 6141 | 2 | 200, full answer |
| 6143 | needs ≥2 | **200, zero-byte body** |
| 6423 | any | 200, zero-byte body |

The limit is on prompt **plus** completion, so a large prompt only fails when
the model would have generated enough to cross 6144 — which is why the same
oversized prompt succeeds or fails at random. A short-output instruction at
`prefill_tokens` 6123 completes reliably, while the same prompt without one does
not. The site's own client caps at the same number
(`NEXT_PUBLIC_TOKEN_LIMIT`, default `6144`) and truncates middle messages past it.

## Known limits

This is a **text-only route**. It is not an agent model.

- **No tool calling.** The API accepts no `tools` field. This adapter ignores
  `options.tools` rather than pretending otherwise, so the model will never
  emit a tool call. Use the route for chat, session titles, and compaction —
  not for tool-driven agent turns.
- **No images or files.** `inputModalities: ['text']` makes `LlmRuntime` project
  images and files to placeholder text before dispatch.
- **No sampling controls.** `temperature`, `maxTokens`, and `stop` are dropped:
  the API has no field for them. `topK` is the one knob it accepts.
- **6144-token context**, prompt and completion together.
- **No server-side history.** The service is stateless; the harness sends the
  full history on every turn.
- **Requests leave your machine.** Prompts go to a third-party service.

## Install

The plugin's only runtime dependency on `@deepseek-ai/*` is
`@deepseek-ai/dsh-llm`, for two pure helpers: `attributionHeaders()` (the
`User-Agent` every provider request must carry) and `resolveRetryPolicy()`.
Nothing else about the host is imported — the surface it touches is declared
structurally in `src/host.ts`. `LlmRuntime` reaches adapters through plain
method calls and never performs an `instanceof LlmAdapter` check, which makes a
duck-typed adapter a supported shape.

```sh
dsh plugin --profile web add /home/maci/dsh-plugins/dsh-chatjimmy
# pnpm warns "declares no dsh.bundle — installed as a plain dependency". That is the point.
```

Then merge this into `~/.dsh/profiles/web/cordis.patch.yml` (the file is
live-watched, so saving remounts the plugin — no restart):

```yaml
- insert:
    - id: chatjimmy
      name: 'dsh-chatjimmy'
      config:
        model: llama3.1-8B
        topK: 8
```

Do not also list this package in `dsh.profile.bundles`: `insert` does not dedupe
ids, and two rows would register the plugin twice (`DUPLICATE_ADAPTER`).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://chatjimmy.ai` | Deployment origin. Must be an absolute http(s) URL. |
| `model` | `llama3.1-8B` | Sent as `chatOptions.selectedModel`. The service accepts any string. |
| `topK` | `8` | Forwarded as `chatOptions.topK`. The site's client sends 8. |
| `contextWindow` | `6144` | Capacity reported to the harness. Change only if the backend changes. |
| `retryPolicy` | *(absent)* | Provider-owned retry policy in the harness `RetryPolicyConfig` shape, e.g. `{ mode: normal, maxRetries: 2 }`. Absent leaves the harness's normal defaults. |

An invalid row throws at load rather than being silently defaulted — a typo'd
`baseUrl` should not surface later as an opaque transport failure.

## Verify

```sh
node --test tests/*.test.ts     # hermetic: stubbed transport, no network
tsc -p tsconfig.json
```

`tests/protocol.test.ts` covers the wire-body projection and the stats splitter
(including every single-character split point of the sentinel).
`tests/adapter.test.ts` covers the stream contract and both failure signatures
over a stubbed fetch. `tests/composition.test.ts` mounts the plugin into a real
Cordis `Context` and proves the route is registered and withdrawn with the
fiber.

## Attribution

`API.md` and this adapter describe a third-party service. The API is
unauthenticated and public; the reconstruction was done by reading the
JavaScript the site serves to any visitor and issuing ordinary requests. No
authentication was bypassed and no private endpoint was reached.
