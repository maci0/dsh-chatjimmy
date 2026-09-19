/**
 * Deterministic performance tests for the per-chunk streaming path that the
 * wall-clock benchmark only reports.
 *
 * Two gates, neither of them wall clock:
 *
 * - The idle watchdog is counted, not timed: one stream must arm a bounded
 *   number of timers, not one `setTimeout`/`clearTimeout` pair per transport
 *   read. The count does not move with machine load.
 * - The whole path runs under a CPU-time band, measured with
 *   `process.cpuUsage()` as the median of several runs over a fixed,
 *   network-free chunk stream with the first run dropped. The band is
 *   deliberately wide (4x the recorded baseline): it is a loaded-CI gate for an
 *   algorithmic regression — a per-record regex, an O(n²) rebuild of the record
 *   buffer, a timer per read — not a micro-benchmark. Tighten it on dedicated
 *   hardware, never below 2x.
 *
 * @module dsh-chatjimmy/tests/perf
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ChatJimmyAdapter } from '../src/adapter.ts'
import type { GenerateOptions } from '../src/host.ts'

/** Deltas in the fixed stream; large enough that CPU time dwarfs timer noise. */
const DELTAS = 8000

/**
 * Median CPU milliseconds this workload cost on the recorded host, and the
 * tolerance multiplier. Baseline: AMD Ryzen 9 9950X, node v26.9.0, pinned to
 * one core (`taskset -c 2`). The constant is the median observed under
 * `node --test`, which roughly doubles the number a bare script reports.
 */
const BASELINE_CPU_MS = 1
const TOLERANCE = 4

const CONFIG = {
  baseUrl: 'https://example.invalid',
  model: 'llama-3.1-8b',
  topK: 8,
  contextWindow: 6144,
  streamIdleTimeoutMs: 300_000,
}

const OPTIONS: GenerateOptions = {
  model: 'llama-3.1-8b',
  system: 'be brief',
  messages: [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

const WORDS = ['streaming', 'tokens', 'arrive', 'here', 'and', 'the', 'buffer', 'frames', 'records', 'fast']

/** A deterministic byte source, so every run replays the identical stream. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** The fixed completion: `DELTAS` text pieces, then the stats sentinel. */
function fixedStream(): string {
  const random = pseudoRandom(0x5eed)
  const parts: string[] = []
  for (let index = 0; index < DELTAS; index += 1) {
    let text = ''
    for (let word = 0; word < 1 + Math.floor(random() * 4); word += 1) {
      text += `${WORDS[Math.floor(random() * WORDS.length)]} `
    }
    if (index % 17 === 0) text += '\n'
    parts.push(text)
  }
  parts.push('<|stats|>{"prefill_tokens":1204,"decode_tokens":4096,"total_tokens":5300,"done_reason":"stop"}<|/stats|>')
  return parts.join('')
}

/** The fixed stream, generated once: every run replays the same bytes. */
const STREAM = fixedStream()
/** Completion text the sentinel splits off: the length every run must emit. */
const COMPLETION_LENGTH = STREAM.indexOf('<|stats|>')

/** Split the stream into transport chunks at fixed, uneven boundaries. */
function transportChunks(text: string): Uint8Array[] {
  const random = pseudoRandom(0xa11ce)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < text.length;) {
    const size = 96 + Math.floor(random() * 1200)
    chunks.push(encoder.encode(text.slice(offset, offset + size)))
    offset += size
  }
  return chunks
}

/**
 * Stream the fixed chunks through the real adapter with a stubbed transport.
 * @returns the number of chunks emitted and the completion length they carried.
 */
async function run(chunks: readonly Uint8Array[]): Promise<{ emitted: number; text: number }> {
  const adapter = new ChatJimmyAdapter(CONFIG, () => Promise.resolve(new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
  let emitted = 0
  let text = 0
  for await (const chunk of adapter.stream(OPTIONS)) {
    emitted += 1
    if (chunk.type === 'text-delta') text += chunk.text.length
  }
  return { emitted, text }
}

test('the idle watchdog arms a bounded number of timers per stream', async () => {
  const chunks = transportChunks(STREAM)
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let armed = 0
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    armed += 1
    return realSetTimeout(callback, ms)
  }) as typeof globalThis.setTimeout
  try {
    const { emitted, text } = await run(chunks)
    // Workload sanity first: a stream that emitted nothing would arm nothing.
    assert.ok(emitted > 3 && text === COMPLETION_LENGTH, `stream carried ${text} of ${COMPLETION_LENGTH} chars in ${emitted} chunks`)
    // One timer covers the whole stream. Anything proportional to `chunks.length`
    // is the per-read `setTimeout`/`clearTimeout` pair this bounds.
    assert.ok(armed <= 4, `watchdog armed ${armed} timers over ${chunks.length} transport reads`)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('the streaming path stays within its CPU-time band', async () => {
  const chunks = transportChunks(STREAM)
  // Workload sanity: a stream that emitted nothing would pass any band, so the
  // completion length is asserted before the timing.
  const { text } = await run(chunks)
  assert.equal(text, COMPLETION_LENGTH)

  const samples: number[] = []
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const before = process.cpuUsage()
    await run(chunks)
    const used = process.cpuUsage(before)
    samples.push((used.user + used.system) / 1000)
  }
  samples.shift() // drop the first: JIT, inline caches, and cold string shapes
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  console.log(`# streaming path CPU median ${median.toFixed(2)}ms over ${DELTAS} deltas (band ${BASELINE_CPU_MS * TOLERANCE}ms)`)

  assert.ok(
    median < BASELINE_CPU_MS * TOLERANCE,
    `streaming path CPU median ${median.toFixed(2)}ms exceeds ${BASELINE_CPU_MS * TOLERANCE}ms`
    + ` (${TOLERANCE}x recorded baseline ${BASELINE_CPU_MS}ms over ${DELTAS} deltas)`,
  )
})
