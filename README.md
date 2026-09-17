# dsh-chatjimmy

A `llama3.1-8B` route inside DeepSeek Harness, served by [chatjimmy.ai](https://chatjimmy.ai/) — no API key and no account, because the endpoint is public.
What you get is not the model. It is the accounting: the harness learns the service's real 6144-token ceiling, so a long session compacts instead of losing the turn to a zero-byte 200.
Install it for chat, session titles, and compaction. It is not an agent model.

## What you get

- A `chatjimmy` provider route in the Web model picker, advertising `llama3.1-8B`.
- A reported 6144-token context window — prompt **and** completion — measured against the live service.
- Streaming replies with the trailing `<|stats|>…<|/stats|>` block stripped and reported as harness usage.
- Failure codes the harness can act on: overflow is `CONTEXT_WINDOW_EXCEEDED`, a stalled stream is `TIMEOUT`, a refused `stop` list is `UNSUPPORTED_OPTION`, caller cancellation is `aborted`.
- No credential record to create. The endpoint is public and unauthenticated.

## Install

```sh
dsh plugin --profile web add github:maci0/dsh-chatjimmy
dsh plugin --profile web update dsh-chatjimmy   # later, to pull main
```

Then restart `dsh web`. Adding or updating the package changes a bundle layer, and bundle layers compose at boot.

## Configure

The defaults work with no row at all. To pin a value, override the row by id in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: chatjimmy
  config:
    model: llama3.1-8B
    topK: 8
```

A patch replaces the targeted row's whole `config`, so restate every key you keep. This file is live-watched: saving it remounts the plugin, no restart needed.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://chatjimmy.ai` | Deployment origin. Must be an absolute http(s) URL; trailing slashes are trimmed. |
| `model` | `llama3.1-8B` | Sent as `chatOptions.selectedModel`. `/api/models` advertises exactly this id; any id is accepted on the wire. |
| `topK` | `8` | Forwarded as `chatOptions.topK`. Must be a positive integer. |
| `contextWindow` | `6144` | Capacity reported to the harness. Change only if the backend does. |
| `streamIdleTimeoutMs` | `300000` | Bound on the gap between two stream reads. A stream this silent ends with `TIMEOUT`. |
| `retryPolicy` | *(absent)* | Provider-owned retry policy in the harness `RetryPolicyConfig` shape, e.g. `{ mode: normal, maxRetries: 2 }`. Absent keeps the harness defaults. |

An invalid row throws at load rather than being silently defaulted: a typo'd `baseUrl` should not surface later as an opaque transport failure.

Do not also insert this row by hand while the package is a bundle in `dsh.profile.bundles`: `insert` does not dedupe ids, and two rows mount the plugin twice.

## Routes and models

One route, one advertised model.

| Route | Picker label | Model id |
|---|---|---|
| `chatjimmy` | Chat Jimmy (Taalas) | `llama3.1-8B` |

The id is advisory — the service mirrors whatever `model` you configured in `listModels()` and accepts any string at request time. This route declares no reasoning efforts, so the picker shows no Effort menu for it.

The 6144-token limit is measured, not read from a header. The backend reports `prefill_tokens` per request, which makes the ceiling observable: 6141 prefill + 2 output tokens answered in full, while a request needing 6143 + 2 returned a zero-byte body. The site's own client caps at the same number (`NEXT_PUBLIC_TOKEN_LIMIT`, default 6144). Because the limit is on prompt **plus** completion, an oversized prompt fails only when the model would have generated enough to cross it — which is why the same prompt succeeds or fails at random.

## Try it

1. Restart `dsh web`, then open a session.
2. Type `/model` in the composer, or click the model seat beside it.
3. Pick **Chat Jimmy (Taalas)** → **Llama 3.1 8B (Chat Jimmy)**. Selecting a model also makes it the default for new sessions; a session that already sent a request keeps the model recorded in its own log.
4. Type a prompt, for example:

```
Suggest four names for a CLI that renames photos.
```

The answer streams in as plain text. Nothing else is needed — no key, no settings page visit.

## How it works

- **Attribution.** Every request carries `attributionHeaders()` from `@deepseek-ai/dsh-llm`, so `User-Agent` cannot drift from the installed harness. That package's pure helpers (`attributionHeaders()`, `resolveRetryPolicy()`) are the plugin's only runtime dependency on `@deepseek-ai/*`; the adapter is duck-typed, not an `LlmAdapter` subclass.
- **Request.** `POST {baseUrl}/api/chat` with the history flattened to text, every system-role message hoisted into the single `systemPrompt` slot, `attachment: null`.
- **Streaming.** The stats filter holds back text only as far as a marker could still be forming, so time-to-first-token is unaffected. Usage is emitted only when the provider reported counters; a synthesized zero would claim a measurement that never happened.
- **Failures.** HTTP 400/422 → `INVALID_REQUEST`, 401/403 → `AUTH`, 429 → `RATE_LIMIT`, 5xx → `SERVER`, anything else → `TRANSPORT`. A zero-byte HTTP 200 is the service's overflow signature, because the response headers are already committed as `text/event-stream` — that becomes `CONTEXT_WINDOW_EXCEEDED`, not an empty answer.
- **Stateless.** The service keeps no history, so the harness sends the full conversation every turn.

The wire contract this adapter implements — `GET /api/health`, `GET /api/models`, `POST /api/chat` — is documented in [`API.md`](API.md). It was reconstructed from the JavaScript the site serves to any visitor plus ordinary requests: no authentication was bypassed and no private endpoint was reached.

## Limits

This is a text-only route. It is not an agent model.

The API accepts no `tools` field, so the adapter ignores `options.tools` rather than pretending otherwise: the model will never emit a tool call. A cross-provider history that contains tool blocks is rendered as prose (`[tool call] name(args)`) so the conversation still reads as one.

- **6144 tokens total**, prompt and completion together.
- **No images or files.** `inputModalities: ['text']` makes `LlmRuntime` project them to placeholder text before dispatch.
- **No sampling controls.** `temperature` and `maxTokens` are dropped — the API has no field for them. `stop` is refused with `UNSUPPORTED_OPTION` instead, because dropping it would change generation semantics. `topK` is the one knob it accepts.
- **No server-side history.** The harness resends everything each turn.
- **Prompts leave your machine** and go to a third-party service (Taalas Inc., per the site's own links).
- **Small model.** An 8B model is a fine chat, title, and compaction route; expect weak long-form reasoning.

## Development

```sh
npm test           # node --test tests/*.test.ts — hermetic, stubbed transport, no network
npm run build      # tsc -p tsconfig.build.json → lib/index.js + lib/types/
npm run typecheck  # tsc -p tsconfig.json
```

The package ships the built `lib/` and declares `dsh.bundle`, so a change to `src/` needs `npm run build` before it takes effect.

Coverage: the wire-body projection and the stats splitter, including every single-character split point of the sentinel; the stream contract and both failure signatures over a stubbed fetch; and a real Cordis `Context` mount proving the route is registered and withdrawn with the fiber.

Requires Node `^22.19.0 || >=24.0.0`.

## Licence

MIT. See [LICENSE](LICENSE).
