# chatjimmy.ai — reverse-engineered API

Target: `https://chatjimmy.ai` (Next.js App Router, `x-powered-by: Next.js`, build `DCOFyTwcWkVONHBVSbo_G`).
Method: static analysis of the served JS chunks (`recon/js/`) plus live black-box probing.
Owner per UI/legal links: Taalas Inc.

## Endpoint inventory

The app exposes exactly three HTTP API routes. Everything else under `/api/*` returns 404.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | none | Readiness probe. Polled by the client every 10 s while on `/down`. |
| GET | `/api/models` | none | OpenAI-shaped model list. |
| POST | `/api/chat` | none | Streaming chat completion. `OPTIONS`/`POST` only; `GET` → 405. |

Confirmed 404: `/api/generate`, `/api/tags`, `/api/version`, `/api/stats`, `/api/status`, `/api/healthz`, `/api/config`, `/v1/models`, `/v1/chat/completions`.

`/api/chat/` (trailing slash) → 308 to `/api/chat`. No CORS headers are emitted, so all three are same-origin only.

There is no base-path prefix in the deployed build: the client computes its base as
`NEXT_PUBLIC_BASE_PATH ?? ""` (webpack module `93448`, export `s`) and appends `/api/...` to it.

## GET /api/health

200, `content-type: application/json`:

```json
{
  "status": "ok",
  "nextjs": "healthy",
  "backend": "healthy",
  "backendStatus": 200,
  "backendDetails": { "status": "healthy", "queue_size": 0, "current_adapter": "none" },
  "timestamp": "2026-09-17T06:10:14.263Z"
}
```

`backendDetails` is the parsed body of an upstream health check that the Next.js handler performs.
POST → 405.

## GET /api/models

200, `content-type: application/json`, `cache-control: no-store`:

```json
{
  "object": "list",
  "data": [
    { "id": "llama3.1-8B", "object": "model", "created": 1690000000, "owned_by": "Taalas Inc." }
  ]
}
```

The client reads `data[0].id` and stores it as `selectedModel`. POST → 405.

## POST /api/chat

Request: `content-type: application/json`.

```json
{
  "messages": [
    { "id": "uuid", "role": "user", "content": "hello" }
  ],
  "chatOptions": {
    "selectedModel": "llama3.1-8B",
    "systemPrompt": "",
    "topK": 8
  },
  "attachment": { "name": "notes.txt", "size": 1234, "content": "raw text" }
}
```

- `messages` is required. Standard user/assistant history, sent in full on every turn
  (`useChat` from Vercel AI SDK v3, `streamMode: "text"`, with `options.body` merged in).
  Message `id` is client-generated; the server echoes the last assistant id back in the stream.
- `chatOptions.selectedModel` is required — any non-empty string passes. The value is **not**
  validated against `/api/models`; `"gpt-4"` is accepted and produces normal output. Only one
  model is actually served.
- `chatOptions.systemPrompt` optional, prepended as a system message. Verified working.
- `chatOptions.topK` optional. Client default is 8; when omitted the upstream reports `topk: 1`.
- `attachment` optional, `null` when absent. Client reads the picked file **as UTF-8 text**
  (`File.text()`), rejects files over 51200 bytes, and sends raw text — not base64, no content type.
- `NEXT_PUBLIC_TOKEN_LIMIT` defaults to `6144` in the client; it only drives a UI counter.

Response: HTTP 200, `content-type: text/event-stream; charset=utf-8`,
`cache-control: no-cache, no-transform`. The body is **not** SSE-framed — it is the raw
generated text, streamed incrementally. Appended at the end, in the same byte stream:

```
<|stats|>{ ...json... }<|/stats|>
```

Example body:

```
Hello my friend
<|stats|>{"created_at":1789625432.0217938,"done":true,"done_reason":"stop","total_duration":0.005132913589477539,"logprobs":null,"topk":8,"ttft":0.0011582374572753906,"reason":"termination token 128009/<|eot_id|> detected","status":0,"prefill_tokens":18,"prefill_rate":15540.854672704816,"decode_tokens":4,"decode_rate":19553.864801864802,"total_tokens":22,"total_time":0.0013763904571533203,"roundtrip_time":13}<|/stats|>
```

The client strips the sentinel with `/<\|stats\|>([\s\S]+?)<\|stats\|>$/` and keeps the JSON as
per-message generation stats (tokens/s, TTFT, prefill/decode split). This is Ollama's
`/api/generate` response shape, so the Next.js route is a thin proxy onto an Ollama-compatible
inference backend.

### Error responses

All errors are `application/json` with `{"success": false, "error": "<message>"}`.

| Status | Trigger | Body |
|---|---|---|
| 400 | `chatOptions` missing, or `selectedModel` empty/absent | `{"success":false,"error":"Selected model is required"}` |
| 500 | body is not valid JSON | `{"success":false,"error":"Unexpected token 'o', \"notjson\" is not valid JSON"}` |
| 500 | `messages` absent or empty | `{"success":false,"error":"Expected text/event-stream but received application/json; body: {\"created_at\":...,\"response\":\"\",\"done\":true,...}"}` |
| 405 | `GET /api/chat` | empty body, `allow: OPTIONS, POST` |

The empty-`messages` case is the interesting one: the handler leaked its upstream contract. It
fetches the backend, then asserts the upstream `content-type` is `text/event-stream` and raises on
anything else. An empty prompt makes the backend answer non-streamed JSON, so the assertion fires
and the backend's raw body lands in the client-visible error string. No upstream hostname is
exposed in any response header.

### Rate limiting / queueing

No `x-ratelimit-*` headers on any route and no 429 observed. Backpressure is surfaced only through
`/api/health`'s `backendDetails.queue_size`.

## Runtime behaviour worth noting

- The root layout gates the whole app: it `GET /api/health` with a 3 s abort, redirects to `/down`
  when it fails, and re-polls every 10 s while there.
- Chat history lives only in browser `localStorage` under `chat_<id>` and `chatstats_<id>`.
  There is no server-side conversation persistence endpoint.
- `/chats/<id>` is a client route over that local storage, not an API.

## Reproducing

```bash
python3 jimmy_client.py                      # self-check + one live turn
curl -sS https://chatjimmy.ai/api/health
curl -sS https://chatjimmy.ai/api/models
curl -sS -X POST https://chatjimmy.ai/api/chat -H 'Content-Type: application/json' \
  --data '{"messages":[{"role":"user","content":"Say hi in 3 words."}],
           "chatOptions":{"selectedModel":"llama3.1-8B","systemPrompt":"","topK":8}}'
```

Raw captures: `recon/index.html`, `recon/js/*.js`, `recon/chat_probe1.txt`, `recon/chat_err.txt`.
