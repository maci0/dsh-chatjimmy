/**
 * Real-composition test: the plugin mounted into a real `@deepseek-ai/cordis`
 * `Context` over a minimal `llm` service.
 *
 * The adapter is duck-typed, so nothing in the plugin records its own
 * registration — the route list and its withdrawal are the service's business.
 * The stub owns routes through the calling fiber's effect, exactly as
 * `LlmRuntime.registerAdapter` does, which is what makes "mounting registers,
 * disposal withdraws" observable without the harness.
 *
 * @module dsh-chatjimmy/tests/composition
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'

import * as plugin from '../src/index.ts'

/**
 * The narrowest stand-in for `ctx.llm`. `this.ctx` traces to the calling fiber,
 * so a route registered from the plugin's `apply` is released when that fiber
 * disposes.
 */
class StubLlm extends Service {
  /** Provider route → adapter, as the service holds them. */
  readonly routes = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * @param providers - routes this adapter serves.
   * @param adapter - the adapter object.
   * @returns the registration's disposer.
   */
  registerAdapter(providers: readonly string[], adapter: unknown): () => void {
    const dispose = this.ctx.effect(() => {
      for (const provider of providers) this.routes.set(provider, adapter)
      return () => {
        for (const provider of providers) this.routes.delete(provider)
      }
    })
    return () => void dispose()
  }
}

test('mounting the plugin registers its route on a real Context, and disposal withdraws it', async () => {
  const ctx = new Context()
  const llm = new StubLlm(ctx)

  const fiber = await ctx.plugin(plugin as unknown as Plugin, {})
  assert.deepEqual([...llm.routes.keys()], [plugin.PROVIDER])
  assert.equal(llm.routes.get(plugin.PROVIDER)?.constructor.name, 'ChatJimmyAdapter')

  await fiber.dispose()
  assert.deepEqual([...llm.routes.keys()], [])
})
