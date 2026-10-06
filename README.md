# opencode-claude-auth for OpenCode V2

This fork targets OpenCode **2.0.22** and `@opencode/plugin` **2.0.22**. It reuses
Claude Code accounts stored in the user's own credentials file or macOS Keychain.
The upstream npm package is not this fork; build this repository locally.

## Build and connect

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run build
```

Add the built directory to `opencode.json(c)`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-claude-auth"],
}
```

Then connect the existing Claude Code account once in OpenCode V2:

```bash
opencode auth login anthropic --method claude-code
```

No browser login is needed when Claude Code already has usable credentials.
When multiple accounts are available, the connection form lets you select the
account. The resulting V2 credential records the selected source; refresh reads
that source. Each OS user keeps their own credentials.

## Runtime behavior

The default export is `Plugin.define` with ID `opencode-claude-auth`. Authentication
is registered through `ctx.integration.transform`; OpenCode manages its own
credential storage and refresh lifecycle. V2 does not synchronize the old
`auth.json` file or start the inherited background synchronization timer.

Claude Code subscription connections use the supported V2 AISDK adapter with
`@ai-sdk/anthropic` 3.0.127 (LanguageModelV3). This preserves the existing signed
request format, OAuth headers, streamed tool-name mapping, bounded 401 recovery,
quota backoff and long-context beta recovery. API-key connections retain their
native provider, pricing and instructions.

The `context`, `compaction`, `generate` and `title` hooks add the Claude Code
identity without removing repository, agent or user instructions. Connection
changes refresh provider/model state. Plugin unload aborts its event subscription;
OpenCode owns cleanup of hook and transform registrations.

`server.js` is a root entrypoint for local directory loading. `src/server.ts` is
the V2 integration; `src/index.ts` contains the inherited request transport and
its regression-tested helpers.

## Diagnostics and validation

`CLAUDE_AUTH_DEBUG` enables diagnostics. Credentials, request bodies, descriptions
and nested sensitive headers are redacted; diagnostic files use mode `0600`.
Logging is disabled by default. Never share credential stores or raw OAuth data.

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
```

Tests cover transport recovery, account selection, managed V2 credentials,
connection changes, API-key isolation, instruction preservation and cleanup.
Real authenticated tests require the user's own active Claude Code account.

The older interception/model-validation scripts remain developer utilities;
read them before use because some perform real token refreshes or requests.

[OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins) ·
[This fork](https://github.com/TheViniAlmeida/opencode-claude-auth)
