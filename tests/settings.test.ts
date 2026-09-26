/**
 * Settings contract: the loader-facing schema, the live row, and the promise
 * that an edit reaches the adapter without a remount.
 *
 * @module dsh-chatjimmy/tests/settings
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { Volatile } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'

import * as plugin from '../src/index.ts'
import { ChatJimmyAdapter } from '../src/adapter.ts'
import type { Config } from '../src/index.ts'
import type { LlmModelInfo } from '../src/host.ts'

/** Provider routes held by the stub `llm` service. */
class StubLlm extends Service {
  readonly routes = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  registerAdapter(providers: readonly string[], adapter: unknown): () => void {
    return this.ctx.effect(() => {
      for (const provider of providers) this.routes.set(provider, adapter)
      return () => {
        for (const provider of providers) this.routes.delete(provider)
      }
    })
  }
}

/** A hand-made volatile reference: exactly the `.get()` seam `apply` uses. */
function ref<T>(read: () => T): { get(): T } {
  return { get: read }
}

test('the schema defaults every editable field', () => {
  const parsed = plugin.Config({}) as unknown as Record<string, { get(): unknown }>
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['baseUrl', 'contextWindow', 'model', 'streamIdleTimeoutMs', 'topK'],
  )
  assert.equal(parsed.baseUrl?.get(), 'https://chatjimmy.ai')
  assert.equal(parsed.model?.get(), 'llama3.1-8B')
  assert.equal(parsed.topK?.get(), 8)
  assert.equal(parsed.contextWindow?.get(), 6144)
  assert.equal(parsed.streamIdleTimeoutMs?.get(), 300_000)
})

test('every field the card edits is volatile and agrees with the resolver', () => {
  const parsed = plugin.Config({}) as unknown as Record<string, { get(): unknown }>
  const resolved = plugin.resolveConfig({})
  for (const key of ['baseUrl', 'model', 'topK', 'contextWindow', 'streamIdleTimeoutMs'] as const) {
    // Volatility is what the settings document requires of an edited path.
    assert.equal(typeof parsed[key]?.get, 'function', `${key} must be volatile`)
    assert.deepEqual(parsed[key]?.get(), resolved[key], `${key} default must match the resolver`)
  }
  // The retry policy is patch-only: no live reference, no card field.
  assert.equal(typeof (parsed.retryPolicy as { get?: unknown } | undefined)?.get, 'undefined')
})

test('liveOptions reads the references the loader resolved', () => {
  const state = { model: 'first' }
  const options = plugin.liveOptions({
    baseUrl: ref(() => 'https://example.test'),
    model: ref(() => state.model),
    topK: ref(() => 3),
    contextWindow: ref(() => 2048),
    streamIdleTimeoutMs: ref(() => 1000),
    retryPolicy: { mode: 'always' },
  } as unknown as Config)
  assert.deepEqual(options, {
    baseUrl: 'https://example.test',
    model: 'first',
    topK: 3,
    contextWindow: 2048,
    streamIdleTimeoutMs: 1000,
    retryPolicy: { mode: 'always' },
  })
  state.model = 'second'
  assert.equal(plugin.liveOptions({
    baseUrl: ref(() => 'https://example.test'),
    model: ref(() => state.model),
    topK: ref(() => 3),
    contextWindow: ref(() => 2048),
    streamIdleTimeoutMs: ref(() => 1000),
  } as unknown as Config).model, 'second')
})

test('an adapter built over a live row follows an edit', async () => {
  const state = { model: 'first', topK: 8, contextWindow: 6144 }
  const adapter = new ChatJimmyAdapter(() => plugin.resolveConfig({
    model: state.model,
    topK: state.topK,
    contextWindow: state.contextWindow,
  }))

  const models = await adapter.listModels(plugin.PROVIDER) as readonly LlmModelInfo[]
  assert.equal(models[0]?.id, 'first')
  assert.deepEqual((await adapter.resolveModel(plugin.PROVIDER, 'first')).context, { contextWindow: 6144 })

  state.model = 'second'
  state.contextWindow = 4096
  assert.equal((await adapter.listModels(plugin.PROVIDER))[0]?.id, 'second')
  assert.deepEqual((await adapter.resolveModel(plugin.PROVIDER, 'second')).context, { contextWindow: 4096 })
})

test('mounting hands the adapter the live row, not a snapshot', async () => {
  const ctx = new Context()
  const llm = new StubLlm(ctx)
  const fiber = await ctx.plugin(plugin as unknown as Plugin, { model: 'first' })
  const adapter = llm.routes.get(plugin.PROVIDER) as { listModels(provider: string): Promise<readonly LlmModelInfo[]> }
  assert.equal((await adapter.listModels(plugin.PROVIDER))[0]?.id, 'first')

  // The settings document commits a volatile write through this same helper and
  // then emits `loader/volatile-update`; the adapter is never rebuilt, which is
  // the whole point of the volatile fields.
  const resolved = (fiber as unknown as { config: { model: Volatile<string> } }).config
  updateVolatile(resolved.model, createVolatile('later'))
  assert.equal((await adapter.listModels(plugin.PROVIDER))[0]?.id, 'later')

  await fiber.dispose()
  assert.deepEqual([...llm.routes.keys()], [])
})

test('an unusable row still fails at mount', async () => {
  const ctx = new Context()
  new StubLlm(ctx)
  await assert.rejects(
    async () => { await ctx.plugin(plugin as unknown as Plugin, { baseUrl: 'not-a-url' }) },
    /not a valid absolute URL/u,
  )
})

test('an edit that made the live row unusable is contained, not thrown at the host', async () => {
  const ctx = new Context()
  new StubLlm(ctx)
  const fiber = await ctx.plugin(plugin as unknown as Plugin, { baseUrl: 'https://chatjimmy.ai' })

  // A card write is committed before the plugin sees it, so the listener must
  // report an unusable row rather than break the event that carried it.
  const resolved = (fiber as unknown as { config: { baseUrl: Volatile<string> } }).config
  updateVolatile(resolved.baseUrl, createVolatile('not-a-url'))
  const emitter = fiber.ctx as unknown as { emit(event: string): void }
  assert.doesNotThrow(() => { emitter.emit('loader/volatile-update') })
  await fiber.dispose()
})

test('the resolver rejects an unusable row instead of defaulting it', () => {
  assert.throws(() => plugin.resolveConfig({ baseUrl: 'ftp://example.test' }), /must use http or https/u)
  assert.throws(() => plugin.resolveConfig({ model: '  ' }), /model must be a non-empty string/u)
  // NaN is refused by the schema's own number check before the finite-number guard.
  assert.throws(() => plugin.resolveConfig({ topK: Number.NaN }))
})
