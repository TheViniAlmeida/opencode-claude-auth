import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Writable } from "node:stream"

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null
let logDescriptor: number | null = null

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export function initLogger(options?: {
  stream?: Writable
  defaultPath?: string
}): void {
  closeLogger()

  if (options?.stream) {
    mode = "stream"
    logStream = options.stream
    return
  }

  const envVal = process.env.CLAUDE_AUTH_DEBUG
  if (!envVal) {
    mode = "disabled"
    return
  }

  mode = "file"
  logFilePath =
    envVal === "1" ? (options?.defaultPath ?? getDefaultLogPath()) : envVal

  const dir = dirname(logFilePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const descriptor = openSync(
    logFilePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  )
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("Diagnostic output must be a regular file")
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600)
    logDescriptor = descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redact(data ?? {}),
  }
  const line = JSON.stringify(entry) + "\n"

  if (mode === "file" && logDescriptor !== null) {
    appendFileSync(logDescriptor, line, "utf-8")
  } else if (mode === "stream" && logStream) {
    logStream.write(line)
  }
}

export function closeLogger(): void {
  if (logDescriptor !== null) closeSync(logDescriptor)
  logDescriptor = null
  mode = "disabled"
  logFilePath = null
  logStream = null
}

function redactValue(key: string, value: unknown): unknown {
  if (
    key === "error" &&
    typeof value === "string" &&
    /^HTTP \d{3}$/.test(value)
  )
    return value
  if (
    /authorization|cookie|token|secret|password|api.?key|^body$|^input$|^messages$|^content$|^message$|Description$|^error$/i.test(
      key,
    )
  )
    return "REDACTED"
  if (Array.isArray(value)) return value.map((entry) => redactValue("", entry))
  if (value && typeof value === "object")
    return redact(value as Record<string, unknown>)
  if (typeof value === "string" && JWT_PATTERN.test(value)) return "REDACTED"
  return value
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, redactValue(key, value)]),
  )
}
