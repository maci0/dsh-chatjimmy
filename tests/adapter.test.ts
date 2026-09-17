/**
 * Adapter tests over a stubbed transport: the stream contract, the sentinel
 * split, and the service's two failure signatures (JSON error envelope and the
 * zero-byte 200 that means context overflow).
 *
 * @module dsh-chatjimmy/tests/adapter
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

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
  const adapter = new ChatJimmyAdapter({ ...CONFIG, streamIdleTimeoutMs: 20 }, async (_url, init) => {
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
