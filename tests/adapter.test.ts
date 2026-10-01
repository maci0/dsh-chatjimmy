/**
 * Adapter tests over a stubbed transport: the stream contract, the sentinel
 * split, and the service's two failure signatures (JSON error envelope and the
 * zero-byte 200 that means context overflow).
 *
 * @module dsh-chatjimmy/tests/adapter
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { ChatJimmyAdapter, CONTEXT_WINDOW_EXCEEDED_CODE, type FetchLike } from '../src/adapter.ts'
import { resolveConfig } from '../src/index.ts'
import type { GenerateOptions, StreamChunk } from '../src/host.ts'

const CONFIG = resolveConfig()
const OPTIONS: GenerateOptions = {
  model: 'llama3.1-8B',
  messages: [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

/** A streaming response whose body arrives in the given byte chunks. */
function streamResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

async function collect(adapter: ChatJimmyAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(OPTIONS)) chunks.push(chunk)
  return chunks
}

function adapterWith(response: Response | (() => Promise<Response>)): ChatJimmyAdapter {
  const impl: FetchLike = async () => (typeof response === 'function' ? response() : response)
  return new ChatJimmyAdapter(CONFIG, impl)
}

test('streams text, splits the sentinel, and reports usage before finish', async () => {
  const chunks = await collect(adapterWith(streamResponse([
    'Hello my ', 'friend\n',
    '<|stats|>{"prefill_tokens":18,"decode_tokens":4,"total_tokens":22,"done_reason":"stop"}<|/stats|>',
  ])))
  const deltas = chunks.filter(chunk => chunk.type === 'text-delta')
    .map(chunk => (chunk as { text: string }).text)
  // Exact chunk boundaries are the transport's business; what matters is that
  // the deltas join to the completion and never carry sentinel bytes.
  assert.equal(deltas.join(''), 'Hello my friend\n')
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks.at(-3), { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello my friend\n' } })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1)
})

test('a zero-byte 200 is reported as context overflow, not as an empty answer', async () => {
  const chunks = await collect(adapterWith(streamResponse([])))
  assert.equal(chunks.length, 1)
  const only = chunks[0]
  assert.equal(only?.type, 'finish')
  const reason = (only as { reason: { kind: string; failure: { code: string; message: string } } }).reason
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.match(reason.failure.message, /6144-token total context/)
})

test('a stats reason naming the context limit is surfaced as that failure', async () => {
  const chunks = await collect(adapterWith(streamResponse([
    '<|stats|>{"reason":"max context limit 6144 reached","done":true}<|/stats|>',
  ])))
  const only = chunks[0] as { type: string; reason: { failure: { code: string } } }
  assert.equal(only.type, 'finish')
  assert.equal(only.reason.failure.code, CONTEXT_WINDOW_EXCEEDED_CODE)
})

test('a completed response with no content is an EMPTY_RESPONSE failure', async () => {
  const chunks = await collect(adapterWith(streamResponse(['<|stats|>{"done":true}<|/stats|>'])))
  const only = chunks[0] as { type: string; reason: { failure: { code: string } } }
  assert.equal(only.type, 'finish')
  assert.equal(only.reason.failure.code, 'EMPTY_RESPONSE')
})

test('a 400 error envelope becomes an INVALID_REQUEST failure', async () => {
  const response = new Response(JSON.stringify({ success: false, error: 'Selected model is required' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
  const chunks = await collect(adapterWith(response))
  const only = chunks[0] as { type: string; reason: { failure: { code: string; message: string; status: number } } }
  assert.equal(only.type, 'finish')
  assert.equal(only.reason.failure.code, 'INVALID_REQUEST')
  assert.equal(only.reason.failure.status, 400)
  assert.match(only.reason.failure.message, /Selected model is required/)
})

test('a transport throw becomes a TRANSPORT failure', async () => {
  const chunks = await collect(adapterWith(() => Promise.reject(new Error('ECONNREFUSED'))))
  const only = chunks[0] as { type: string; reason: { failure: { code: string; message: string } } }
  assert.equal(only.reason.failure.code, 'TRANSPORT')
  assert.match(only.reason.failure.message, /ECONNREFUSED/)
})

test('advertises one text-only model with the measured context window', async () => {
  const adapter = adapterWith(streamResponse([]))
  const models = await adapter.listModels('chatjimmy')
  assert.deepEqual(models.map(m => m.id), ['llama3.1-8B'])
  assert.deepEqual(models[0]?.inputModalities, ['text'])
  const resolved = await adapter.resolveModel('chatjimmy', 'llama3.1-8B')
  assert.equal(resolved.context?.contextWindow, 6144)
  const prepared = await adapter.prepareCall('chatjimmy', 'llama3.1-8B')
  assert.equal(prepared.model.id, 'llama3.1-8B')
  assert.equal(adapter.providerInfo('chatjimmy').id, 'chatjimmy')
  assert.equal(adapter.providerRetryPolicy('chatjimmy'), undefined)
  assert.equal(adapter.imageRequestPricing('chatjimmy', 'llama3.1-8B'), undefined)
})

test('a configured retry policy is reported resolved, an absent one as undefined', () => {
  const configured = new ChatJimmyAdapter(
    { ...CONFIG, retryPolicy: { mode: 'normal', maxRetries: 2 } },
    async () => streamResponse([]),
  )
  assert.deepEqual(configured.providerRetryPolicy('chatjimmy'), {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })
  assert.equal(adapterWith(streamResponse([])).providerRetryPolicy('chatjimmy'), undefined)
})

test('a caller abort ends as aborted, not as a provider error', async () => {
  const controller = new AbortController()
  const adapter = new ChatJimmyAdapter(CONFIG, async (_url, _init) => {
    controller.abort()
    throw new Error('aborted')
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ ...OPTIONS, signal: controller.signal })) chunks.push(chunk)
  const only = chunks[0] as { reason: { kind: string; failure: { code: string } } }
  assert.equal(only.reason.kind, 'aborted')
  assert.equal(only.reason.failure.code, 'ABORTED')
})

test('a stalled stream ends with TIMEOUT at the configured idle bound', async () => {
  let config = { ...CONFIG, streamIdleTimeoutMs: 20 }
  const adapter = new ChatJimmyAdapter(() => config, async (_url, init) => {
    config = { ...config, streamIdleTimeoutMs: 500 }
    const signal = init.signal
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('idle abort')))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const chunks = await collect(adapter)
  const only = chunks[0] as { reason: { kind: string; failure: { code: string; message: string } } }
  assert.equal(only.reason.kind, 'error')
  assert.equal(only.reason.failure.code, 'TIMEOUT')
  assert.match(only.reason.failure.message, /20ms/)
})

test('HTTP error bodies obey the idle bound and preserve caller cancellation', async () => {
  for (const [idleMs, cancelMs, kind, code] of [[20, 150, 'error', 'TIMEOUT'], [150, 20, 'aborted', 'ABORTED']] as const) {
    const adapter = new ChatJimmyAdapter({ ...CONFIG, streamIdleTimeoutMs: idleMs }, async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new Error('read aborted')), { once: true })
      },
    }), { status: 429 }))
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ ...OPTIONS, signal: AbortSignal.timeout(cancelMs) })) chunks.push(chunk)
    assert.equal(chunks.length, 1)
    const finish = chunks[0]
    assert.ok(finish?.type === 'finish' && (finish.reason.kind === 'error' || finish.reason.kind === 'aborted'))
    assert.equal(finish.reason.kind, kind)
    assert.equal(finish.reason.failure.code, code)
  }
})

test('consumer backpressure does not abort a healthy provider stream', async () => {
  let signal: AbortSignal | null | undefined
  const adapter = new ChatJimmyAdapter({ ...CONFIG, streamIdleTimeoutMs: 20 }, async (_url, init) => {
    signal = init.signal
    return streamResponse(['hello', '<|stats|>{"done_reason":"stop"}<|/stats|>'])
  })
  const iterator = adapter.stream(OPTIONS)[Symbol.asyncIterator]()
  try {
    assert.equal((await iterator.next()).value?.type, 'block-start')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(signal?.aborted, false, 'no provider read was pending during the consumer wait')
    const chunks: StreamChunk[] = []
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) chunks.push(next.value)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally {
    await iterator.return?.()
  }
})

test('a request that sets stop sequences is refused instead of dropped', async () => {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapterWith(streamResponse(['never sent'])).stream({ ...OPTIONS, stop: ['END'] })) {
    chunks.push(chunk)
  }
  const only = chunks[0] as { reason: { failure: { code: string } } }
  assert.equal(only.reason.failure.code, 'UNSUPPORTED_OPTION')
})

test('the wire request carries attribution and the documented body', async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const adapter = new ChatJimmyAdapter(CONFIG, async (url, init) => {
    seen = { url, init }
    return streamResponse(['ok<|stats|>{}<|/stats|>'])
  })
  await collect(adapter)
  assert.equal(seen?.url, 'https://chatjimmy.ai/api/chat')
  assert.equal(seen?.init.method, 'POST')
  const headers = seen?.init.headers as Record<string, string>
  // Assert against the live helper, never a pinned copy that could drift.
  const userAgent = String(attributionHeaders()['user-agent'])
  assert.equal(headers['user-agent'], userAgent)
  assert.match(userAgent, /^deepseek-harness\/\S+ \(\+https:\/\/github\.com\/deepseek-ai\/deepseek-harness\)$/)
  assert.deepEqual(JSON.parse(String(seen?.init.body)), {
    messages: [{ role: 'user', content: 'hi' }],
    chatOptions: { selectedModel: 'llama3.1-8B', systemPrompt: '', topK: 8 },
    attachment: null,
  })
})

test('a tool-role result reaches the wire labelled as one', async () => {
  // The harness carries a tool result as a `tool`-role message whose content is
  // plain text blocks; there is no `tool-result` content block.
  let sent: { messages: { role: string; content: string }[] } | undefined
  const adapter = new ChatJimmyAdapter(CONFIG, async (_url, init) => {
    sent = JSON.parse(String(init.body)) as typeof sent
    return streamResponse(['done'])
  })
  const options: GenerateOptions = {
    model: 'llama3.1-8B',
    messages: [
      { id: '1', role: 'user', content: [{ type: 'text', text: 'read x' }] },
      { id: '2', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"x"}' }] },
      { id: '3', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    ],
  }
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
  assert.deepEqual(sent?.messages, [
    { role: 'user', content: 'read x' },
    { role: 'assistant', content: '[tool call] read({"path":"x"})' },
    { role: 'user', content: '[tool result] ok' },
  ])
})

test('a stats block without token counters reports no usage', async () => {
  const chunks = await collect(adapterWith(streamResponse(['hi', '<|stats|>{"done":true,"done_reason":"stop"}<|/stats|>'])))
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a request whose history flattens to nothing is refused before any request is sent', async () => {
  // The backend answers an empty `messages` list with HTTP 500 (API.md), which
  // the harness would retry as SERVER. Only the system slot carries text here.
  let calls = 0
  const adapter = new ChatJimmyAdapter(CONFIG, async () => {
    calls += 1
    return streamResponse(['never sent'])
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    model: 'llama3.1-8B',
    system: 'be brief',
    messages: [
      { id: '1', role: 'system', content: [{ type: 'text', text: 'loop system' }] },
      { id: '2', role: 'user', content: [{ type: 'text', text: '' }] },
    ],
  })) chunks.push(chunk)

  assert.equal(calls, 0)
  assert.equal(chunks.length, 1)
  const only = chunks[0] as { type: string; reason: { kind: string; failure: { code: string; message: string } } }
  assert.equal(only.type, 'finish')
  assert.equal(only.reason.kind, 'error')
  assert.equal(only.reason.failure.code, 'INVALID_REQUEST')
  assert.match(only.reason.failure.message, /no message text/)
  // The harness's default retry policy must not retry this code.
  const policy = resolveRetryPolicy({ mode: 'normal' }, 'test')
  assert.ok(policy.mode === 'normal' && !policy.retryableCodes.includes(only.reason.failure.code))
})


test('failed requests preserve valid Retry-After delays and omit invalid ones', async () => {
  const future = new Date(Date.now() + 60_000).toUTCString()
  const cases: [string | undefined, number | undefined][] = [
    ['12', 12_000], ['0.5', 500], [' 2 ', 2_000], [future, -1],
    [undefined, undefined], ['', undefined], ['0', undefined], ['-9999', undefined],
    ['1e3', undefined], ['Infinity', undefined], ['nonsense', undefined],
    ['Wed, 01 Jan 2020 00:00:00 GMT', undefined], ['9'.repeat(400), undefined],
  ]
  for (const [header, expected] of cases) {
    const headers = new Headers()
    if (header !== undefined) headers.set('Retry-After', header)
    const chunks = await collect(adapterWith(new Response('{"error":"slow down"}', { status: 429, headers })))
    const finish = chunks[0]
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
    const failure = finish.reason.failure
    assert.equal(failure.code, 'RATE_LIMIT')
    assert.equal(failure.status, 429)
    if (expected === -1) {
      assert.ok(failure.providerRetryAfterMs! > 55_000 && failure.providerRetryAfterMs! <= 60_000)
    } else {
      assert.equal(failure.providerRetryAfterMs, expected, String(header))
      if (expected === undefined) assert.equal('providerRetryAfterMs' in failure, false)
    }
  }
})
