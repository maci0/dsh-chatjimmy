/**
 * Pure protocol tests: wire-body projection and the stats-sentinel splitter.
 *
 * @module dsh-chatjimmy/tests/protocol
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatRequest,
  flatten,
  isContextLimitReason,
  mapUsage,
  parseStats,
  projectHistory,
  resolveConfig,
  STATS_CLOSE,
  STATS_OPEN,
  StatsStreamFilter,
} from '../src/index.ts'
import type { GenerateOptions } from '../src/host.ts'

const CONFIG = resolveConfig()

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'chatjimmy',
    model: 'llama3.1-8B',
    messages: [
      { id: '1', role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { id: '2', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { id: '3', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { id: '4', role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
    ...overrides,
  }
}

test('projects harness history onto the wire shape', () => {
  const { systemPrompt, messages } = projectHistory(request(), '')
  assert.equal(systemPrompt, 'be brief')
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' },
  ])
})

test('one-shot system text wins and empty history drops out', () => {
  const { systemPrompt, messages } = projectHistory(request({ system: 'override' }), 'configured')
  assert.equal(systemPrompt, 'override\n\nbe brief')
  assert.equal(messages.length, 3)
  assert.deepEqual(projectHistory({ ...request({ messages: [] }) }, 'configured').messages, [])
  assert.equal(projectHistory(request({ messages: [] }), 'configured').systemPrompt, 'configured')
})

test('renders tool blocks as prose because the service has no tool protocol', () => {
  const text = flatten([
    { type: 'text', text: 'a' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"x"}' },
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    { type: 'image', attachment: {} },
  ])
  assert.equal(text, 'a[tool call] read({"path":"x"})[tool result] ok')
})

test('builds the exact documented request body', () => {
  const body = buildChatRequest(request(), CONFIG)
  assert.deepEqual(body, {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' },
    ],
    chatOptions: { selectedModel: 'llama3.1-8B', systemPrompt: 'be brief', topK: 8 },
    attachment: null,
  })
})

test('an empty model id falls back to the configured one', () => {
  assert.equal(buildChatRequest(request({ model: '' }), CONFIG).chatOptions.selectedModel, 'llama3.1-8B')
})

test('config rejects an unusable row instead of defaulting it', () => {
  assert.equal(resolveConfig({ baseUrl: 'https://x.test/' }).baseUrl, 'https://x.test')
  assert.equal(resolveConfig({ contextWindow: 2048 }).contextWindow, 2048)
  assert.throws(() => resolveConfig({ baseUrl: 'not a url' }), /not a valid absolute URL/)
  assert.throws(() => resolveConfig({ baseUrl: 'ftp://x.test' }), /must use http or https/)
  assert.throws(() => resolveConfig({ model: '  ' }), /non-empty/)
  assert.throws(() => resolveConfig({ topK: 0 }), /positive integer/)
  assert.throws(() => resolveConfig({ contextWindow: 1.5 }), /positive integer/)
})

test('splitter emits completion text and never leaks the sentinel', () => {
  const filter = new StatsStreamFilter()
  const chunks = ['Hel', 'lo ', 'wor', 'ld\n', STATS_OPEN, '{"prefill_tokens":18,"decode_tokens":2,"total_tokens":20}', STATS_CLOSE]
  let out = ''
  for (const chunk of chunks) out += filter.push(chunk)
  out += filter.flush()
  assert.equal(out, 'Hello world\n')
  assert.equal(filter.stats?.prefill_tokens, 18)
})

test('splitter holds back a marker split across chunk boundaries', () => {
  // Every single-character split point must produce identical output.
  const full = `answer${STATS_OPEN}{"total_tokens":9}${STATS_CLOSE}`
  for (let cut = 0; cut <= full.length; cut += 1) {
    const filter = new StatsStreamFilter()
    const out = filter.push(full.slice(0, cut)) + filter.push(full.slice(cut)) + filter.flush()
    assert.equal(out, 'answer', `split at ${cut}`)
    assert.equal(filter.stats?.total_tokens, 9, `split at ${cut}`)
  }
})

test('splitter releases residual text when no sentinel ever arrives', () => {
  const filter = new StatsStreamFilter()
  let out = filter.push('partial answer')
  out += filter.flush()
  assert.equal(out, 'partial answer')
  assert.equal(filter.stats, undefined)
})

test('splitter ignores everything after the sentinel', () => {
  const filter = new StatsStreamFilter()
  const out = filter.push(`done${STATS_OPEN}{}${STATS_CLOSE}trailing`) + filter.flush()
  assert.equal(out, 'done')
  assert.deepEqual(filter.stats, {})
})

test('stats helpers tolerate junk', () => {
  assert.equal(parseStats('{oops'), undefined)
  assert.equal(parseStats('null'), undefined)
  assert.equal(isContextLimitReason('max context limit 6144 reached'), true)
  assert.equal(isContextLimitReason('max  context  limit  6144  reached'), true)
  assert.equal(isContextLimitReason('termination token 128009 detected'), false)
  assert.equal(isContextLimitReason(undefined), false)
  assert.deepEqual(mapUsage(undefined), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  assert.deepEqual(
    mapUsage({ prefill_tokens: 18, decode_tokens: 4, total_tokens: 22 }),
    { inputTokens: 18, outputTokens: 4, totalTokens: 22 },
  )
})
