import { createAnthropic } from "@ai-sdk/anthropic"
import { Credential, Integration, Plugin } from "@opencode/plugin"
import createTransport, { SYSTEM_IDENTITY } from "./index.ts"
import {
  getCachedCredentials,
  initAccounts,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  setActiveAccountSource,
  type ClaudeCredentials,
} from "./credentials.ts"
import { readAllClaudeAccounts } from "./keychain.ts"
import { closeLogger } from "./logger.ts"

const PROVIDER_ID = "anthropic"
// An explicit SDK file keeps the core from rewriting it to the native driver.
const ANTHROPIC_PACKAGE = `aisdk:${import.meta.resolve("@ai-sdk/anthropic")}`
const METHOD_ID = Integration.MethodID.make("claude-code")

function toCredential(
  credentials: ClaudeCredentials,
  source: string,
): Credential.OAuth {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: credentials.accessToken,
    refresh: credentials.refreshToken ?? "",
    expires: credentials.expiresAt,
    metadata: { source },
  })
}

export const ClaudeAuthPlugin = Plugin.define({
  id: "opencode-claude-auth",
  async setup(ctx) {
    let accounts = readAllClaudeAccounts()
    const controller = new AbortController()
    let currentOAuth: Credential.OAuth | undefined
    let cachedSource: string | undefined
    let transport: Awaited<ReturnType<typeof createTransport>> | undefined
    let transportPromise:
      | Promise<Awaited<ReturnType<typeof createTransport>>>
      | undefined

    const selectSource = (source?: string) => {
      accounts = refreshAccountsList()
      if (!accounts.length) accounts = readAllClaudeAccounts()
      const selected =
        accounts.find((account) => account.source === source) ??
        accounts.find(
          (account) => account.source === loadPersistedAccountSource(),
        ) ??
        accounts[0]
      if (!selected)
        throw new Error(
          "No Claude Code credentials available; run claude to sign in",
        )
      if (source && selected.source !== source)
        throw new Error("Selected Claude Code account is unavailable")
      initAccounts(accounts)
      setActiveAccountSource(selected.source)
      return selected
    }
    const resolveOAuth = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      const value = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined
      return value?.type === "oauth" && value.methodID === METHOD_ID
        ? value
        : undefined
    }

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "Use Claude Code account",
          ...(accounts.length > 1
            ? {
                form: [
                  {
                    type: "string" as const,
                    key: "account",
                    title: "Claude Code account",
                    options: accounts.map((account) => ({
                      value: account.source,
                      label: account.label,
                    })),
                    default: accounts[0].source,
                  },
                ] as const,
              }
            : {}),
        },
        authorize: async (answer) => {
          const selected = selectSource(
            typeof answer.account === "string" ? answer.account : undefined,
          )
          const credentials = await getCachedCredentials()
          if (!credentials)
            throw new Error(
              "Claude Code credentials could not be refreshed; run claude to sign in",
            )
          return {
            mode: "auto" as const,
            url: "",
            instructions: "Using the selected local Claude Code account.",
            callback: Promise.resolve(
              toCredential(credentials, selected.source),
            ),
          }
        },
        refresh: async (credential) => {
          const selected = selectSource(
            typeof credential.metadata?.source === "string"
              ? credential.metadata.source
              : undefined,
          )
          // Align with the core's five-minute refresh window to avoid repeated no-op refreshes.
          const credentials = await refreshIfNeeded(selected, 5 * 60 * 1000)
          if (!credentials)
            throw new Error(
              "Claude Code credentials could not be refreshed; run claude to sign in",
            )
          return toCredential(credentials, selected.source)
        },
      })
    })

    currentOAuth = await resolveOAuth()
    await ctx.provider.transform((editor) => {
      if (!currentOAuth || !editor.get(PROVIDER_ID)) return
      // AISDK transport preserves the existing quota recovery and Claude Code signing.
      editor.update(PROVIDER_ID, (provider) => {
        provider.package = ANTHROPIC_PACKAGE
      })
    })
    await ctx.model.transform((editor) => {
      if (!currentOAuth) return
      for (const model of editor.list(PROVIDER_ID))
        editor.update(PROVIDER_ID, String(model.id), (draft) => {
          draft.package = ANTHROPIC_PACKAGE
          draft.cost = []
        })
    })

    await ctx.aisdk.hook(
      "sdk",
      async (event) => {
        const credential = await resolveOAuth()
        if (!credential) return
        const source =
          typeof credential.metadata?.source === "string"
            ? credential.metadata.source
            : undefined
        if (!transportPromise || cachedSource !== source) {
          cachedSource = source
          selectSource(source)
          transportPromise = createTransport({
            legacyAuthSync: false,
            proactiveRefresh: false,
          })
        }
        try {
          transport = await transportPromise
          if (!transport.auth)
            throw new Error("Claude Code credential source could not be loaded")
        } catch (error) {
          transportPromise = undefined
          transport = undefined
          cachedSource = undefined
          throw error
        }
        // Initialization uses the persisted source; enforce the selected V2 connection afterwards.
        selectSource(source)
        const options = await transport.auth.loader(
          async () => ({ type: "oauth" }),
          { models: {} },
        )
        if (!("fetch" in options))
          throw new Error("Claude Code transport could not be initialized")
        event.options.fetch = options.fetch
        event.options.apiKey = ""
        // Use the pinned LanguageModelV3 SDK rather than the core's latest npm lookup.
        event.sdk = createAnthropic(event.options)
      },
      { providerID: PROVIDER_ID },
    )

    for (const name of [
      "context",
      "compaction",
      "generate",
      "title",
    ] as const) {
      await ctx.session.hook(
        name,
        async (event) => {
          if (!(await resolveOAuth())) return
          if (
            !event.system.some(
              (part) =>
                part.type === "text" && part.text.includes(SYSTEM_IDENTITY),
            )
          ) {
            event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
          }
        },
        { providerID: PROVIDER_ID },
      )
    }

    const update = async () => {
      currentOAuth = await resolveOAuth()
      await ctx.provider.reload()
      await ctx.model.reload()
    }
    const stream = (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        if (
          (event.type === "credential.switched" &&
            event.data.integrationID === PROVIDER_ID) ||
          event.type === "credential.updated"
        )
          await update()
      }
    })()
    void stream.catch(() => {
      if (!controller.signal.aborted)
        console.error("opencode-claude-auth: connection update failed")
    })
    return () => {
      controller.abort()
      closeLogger()
    }
  },
})

export default ClaudeAuthPlugin
