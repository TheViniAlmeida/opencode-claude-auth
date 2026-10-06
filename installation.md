# OpenCode V2 installation

Build this fork with `pnpm install --frozen-lockfile --ignore-scripts` and
`pnpm run build`. Add its absolute directory to the `plugins` array in your
OpenCode V2 configuration, preserving existing entries. The root `server.js`
loads the compiled `dist/server.js` definition.

Run `opencode auth login anthropic --method claude-code` to register your own
existing Claude Code account with the V2 integration. This does not synchronize
V1's `auth.json`. Each OS user must connect their own account; credentials must
not be copied across users.

For validation and runtime details, see [README.md](README.md).
