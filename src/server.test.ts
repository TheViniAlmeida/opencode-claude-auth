import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it } from "node:test"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "claude-v2-fixture-"))
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir")
  await writeFile(join(dir, "logger.ts"), "export function closeLogger() {}")
  await writeFile(
    join(dir, "state.ts"),
    `
export const accounts = ["A", "B"].map(source => ({ source, label: "Fixture " + source, credentials: { accessToken: "fixture-access-" + source, refreshToken: "fixture-refresh-" + source, expiresAt: Date.now() + 3600000 } }))
export const state = { accounts, current: "A", options: [], creates: 0, refreshThresholds: [], failNext: false }
`,
  )
  await writeFile(
    join(dir, "keychain.ts"),
    `import { state } from "./state.ts"; export function readAllClaudeAccounts() { return state.accounts }`,
  )
  await writeFile(
    join(dir, "credentials.ts"),
    `
import { state } from "./state.ts"
export function initAccounts(accounts) { state.accounts = accounts }
export function refreshAccountsList() { return state.accounts }
export function loadPersistedAccountSource() { return "A" }
export function setActiveAccountSource(source) { state.current = source }
export async function getCachedCredentials() { return state.accounts.find(a => a.source === state.current)?.credentials }
export async function refreshIfNeeded(account, threshold) { state.refreshThresholds.push(threshold); return account.credentials }
`,
  )
  await writeFile(
    join(dir, "index.ts"),
    `
import { state } from "./state.ts"
export const SYSTEM_IDENTITY = "Fixture Claude Code Identity"
export default async function create(options) {
 state.options.push(options); state.creates++; state.current = "A"
 if (state.failNext) { state.failNext = false; return {} }
 return { auth: { async loader() { return { fetch: async () => new Response(state.current) } } } }
}
`,
  )
  await writeFile(
    join(dir, "server.ts"),
    await readFile(new URL("./server.ts", import.meta.url), "utf8"),
  )
  const { default: plugin } = await import(
    pathToFileURL(join(dir, "server.ts")).href
  )
  const { state } = await import(pathToFileURL(join(dir, "state.ts")).href)
  return { plugin, state }
}
async function harness(
  credential: any = {
    type: "oauth",
    methodID: "claude-code",
    metadata: { source: "B" },
  },
) {
  const f = await fixture()
  const methods = new Map()
  const hooks = new Map()
  const sdk = new Map()
  const source = {
    provider: { package: "native-anthropic" },
    models: new Map(),
  }
  const model = {
    id: "haiku",
    package: "@opencode/ai/providers/anthropic",
    cost: [{ input: 1 }],
  }
  const queue: any[] = []
  let wake: (() => void) | undefined
  let done = false
  let reloads = 0
  const ctx = {
    integration: {
      transform: async (cb) =>
        cb({
          method: {
            update: (definition) =>
              methods.set(definition.method.id, definition),
          },
        }),
      connection: { active: async () => ({}), resolve: async () => credential },
    },
    provider: {
      transform: async (cb) =>
        cb({
          get: () => source,
          update: (_id, apply) => apply(source.provider),
        }),
      reload: async () => {
        reloads++
      },
    },
    model: {
      transform: async (cb) =>
        cb({
          list: () => [model],
          update: (_provider, _id, apply) => apply(model),
        }),
      reload: async () => {},
    },
    aisdk: {
      hook: async (name, cb, scope) => {
        assert.deepEqual(scope, { providerID: "anthropic" })
        sdk.set(name, cb)
      },
    },
    session: {
      hook: async (name, cb, scope) => {
        assert.deepEqual(scope, { providerID: "anthropic" })
        hooks.set(name, cb)
      },
    },
    event: {
      subscribe: ({ signal }) =>
        (async function* () {
          signal.addEventListener(
            "abort",
            () => {
              done = true
              wake?.()
            },
            { once: true },
          )
          for (;;) {
            if (done) break
            if (!queue.length)
              await new Promise<void>((r) => {
                wake = r
              })
            while (queue.length) yield queue.shift()
          }
        })(),
    },
  }
  const cleanup = await f.plugin.setup(ctx)
  return {
    ...f,
    methods,
    hooks,
    sdk,
    source,
    model,
    cleanup,
    select: (next: any) => {
      credential = next
    },
    emit: async (event: any) => {
      queue.push(event)
      wake?.()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    },
    reloads: () => reloads,
    stopped: () => done,
  }
}

describe("V2 integration lifecycle", () => {
  it("registers a source-selection OAuth method and routes only the linked subscription through AISDK", async () => {
    const h = await harness()
    assert.equal(h.plugin.id, "opencode-claude-auth")
    assert.equal(h.methods.get("claude-code").method.form[0].key, "account")
    assert.equal(
      h.source.provider.package,
      `aisdk:${import.meta.resolve("@ai-sdk/anthropic")}`,
    )
    assert.equal(
      h.model.package,
      `aisdk:${import.meta.resolve("@ai-sdk/anthropic")}`,
    )
    assert.deepEqual(h.model.cost, [])
    h.cleanup()
  })
  it("authorizes only the explicitly selected local account and produces a managed V2 credential", async () => {
    const h = await harness()
    const flow = await h.methods.get("claude-code").authorize({ account: "B" })
    assert.equal(flow.mode, "auto")
    const credential = await flow.callback
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, "claude-code")
    assert.equal(credential.access, "fixture-access-B")
    assert.equal(credential.metadata.source, "B")
    h.cleanup()
  })
  it("refreshes the credential from its own source rather than the previously active account", async () => {
    const h = await harness()
    const next = await h.methods
      .get("claude-code")
      .refresh({ metadata: { source: "B" } })
    assert.equal(next.access, "fixture-access-B")
    assert.equal(next.metadata.source, "B")
    assert.deepEqual(h.state.refreshThresholds, [300000])
    h.cleanup()
  })
  it("rejects an unavailable selected source without falling back to another account", async () => {
    const h = await harness()
    await assert.rejects(
      h.methods.get("claude-code").authorize({ account: "unavailable" }),
      /unavailable/,
    )
    h.cleanup()
  })
  for (const name of ["context", "compaction", "generate", "title"]) {
    it(`preserves repository system instructions on ${name} calls`, async () => {
      const h = await harness()
      const event = { system: [{ type: "text", text: "Repository policy" }] }
      await h.hooks.get(name)(event)
      assert.deepEqual(
        event.system.map((p) => p.text),
        ["Fixture Claude Code Identity", "Repository policy"],
      )
      await h.hooks.get(name)(event)
      assert.equal(event.system.length, 2)
      h.cleanup()
    })
  }
  it("initializes the preserved fetch transport without a V1 credential writer or background timer", async () => {
    const h = await harness()
    const event = { options: {} as any }
    await h.sdk.get("sdk")(event)
    assert.deepEqual(h.state.options, [
      { legacyAuthSync: false, proactiveRefresh: false },
    ])
    assert.equal(await (await event.options.fetch()).text(), "B")
    assert.equal(event.options.apiKey, "")
    assert.equal(
      event.sdk.languageModel("claude-haiku-4-5").specificationVersion,
      "v3",
    )
    h.cleanup()
  })
  it("resolves an account switch on subsequent SDK requests and reloads native model/provider state", async () => {
    const h = await harness()
    const first = { options: {} as any }
    await h.sdk.get("sdk")(first)
    h.select({
      type: "oauth",
      methodID: "claude-code",
      metadata: { source: "A" },
    })
    await h.emit({
      type: "credential.switched",
      data: { integrationID: "anthropic" },
    })
    assert.equal(h.reloads(), 1)
    const next = { options: {} as any }
    await h.sdk.get("sdk")(next)
    assert.equal(await (await next.options.fetch()).text(), "A")
    assert.equal(h.state.creates, 2)
    h.cleanup()
    assert.equal(h.stopped(), true)
  })
  it("retries a temporary transport initialization failure after the source recovers", async () => {
    const h = await harness()
    h.state.failNext = true
    await assert.rejects(
      h.sdk.get("sdk")({ options: {} }),
      /could not be loaded/,
    )
    const event = { options: {} as any }
    await h.sdk.get("sdk")(event)
    assert.equal(await (await event.options.fetch()).text(), "B")
    assert.equal(h.state.creates, 2)
    h.cleanup()
  })

  it("preserves the native driver for OAuth connections registered by another method", async () => {
    const h = await harness({ type: "oauth", methodID: "another-method" })
    const event = { options: {} as any }
    await h.sdk.get("sdk")(event)
    assert.equal(h.source.provider.package, "native-anthropic")
    assert.equal(h.model.package, "@opencode/ai/providers/anthropic")
    assert.deepEqual(h.model.cost, [{ input: 1 }])
    assert.equal(event.options.fetch, undefined)
    assert.equal(h.state.creates, 0)
    h.cleanup()
  })

  it("does not alter API-key connections, their cost, or system instructions", async () => {
    const h = await harness({ type: "key", key: "fixture-api-key" })
    const sdk = { options: { apiKey: "fixture-api-key" } }
    await h.sdk.get("sdk")(sdk)
    assert.equal(sdk.options.apiKey, "fixture-api-key")
    assert.equal(h.source.provider.package, "native-anthropic")
    assert.equal(h.model.package, "@opencode/ai/providers/anthropic")
    assert.deepEqual(h.model.cost, [{ input: 1 }])
    const context = { system: [{ type: "text", text: "API key policy" }] }
    await h.hooks.get("context")(context)
    assert.equal(context.system.length, 1)
    assert.equal(h.state.creates, 0)
    h.cleanup()
  })
})
