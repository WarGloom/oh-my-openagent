import { createHash } from "node:crypto"
import { basename } from "node:path"
import { questions } from "./jev-router-model"
import { resolveJevBriefs, type BriefStatus } from "./jev-brief-resolver"

const boilerplate =
  /(?:tool whitelist|allowed tools|report format|report back|scratch[- ](?:dir|directory)|memory gateway|skill reminder|load (?:the )?skill|continue without waiting)/i
const limitPattern =
  /\b(?:read[- ]only|must not|do not|don't|never|no\s+(?:edits?|changes?|modifications?|builds?|tests?|commits?|push(?:es)?|new\s+behaviou?r)|single[- ]file|only (?:edit|modify|change|touch|one file))\b/i
const filesystem =
  /(?<![\w/])(?:~\/|\.\.\/|\.\/|\/)[\w.@+~-]+(?:\/[\w.@+~-]+)*\/?|(?<![\w/])[\w.@+~-]+(?:\/[\w.@+~-]+){2,}\.[A-Za-z0-9_-]+\b/g
const secretRules = [
  [/-----BEGIN[\w ]*PRIVATE KEY-----[\s\S]*?-----END[\w ]*PRIVATE KEY-----/gi, 0],
  [/\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+:[^\s/@]+)@/gi, 1],
  [/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, 0],
  [
    /\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|пароль|token|[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*["']?\s*[:=]\s*["']?(?!\[REDACTED\])((?:bearer\s+)?[^\s"'\],;}]+)/gi,
    1,
  ],
  [/\bbearer\s+(?!\[REDACTED\])([^\s"'\],;}]+)/gi, 1],
  [
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    0,
  ],
  [
    /(?=[A-Za-z0-9+\/_=-]{48,}\b)(?=[A-Za-z0-9+\/_=-]*[A-Z])(?=[A-Za-z0-9+\/_=-]*[a-z])(?=[A-Za-z0-9+\/_=-]*[0-9])[A-Za-z0-9+\/_=-]{48,}/g,
    0,
  ],
] as const

export function sanitizeJevText(source: string): string {
  let text = source
  for (const [pattern, group] of secretRules) {
    text = text.replace(pattern, (match: string, captured: string) => {
      const value = group ? captured : match
      if (value.startsWith("[REDACTED]")) return match
      if (!group) return "[REDACTED]"
      const index = match.lastIndexOf(value)
      return match.slice(0, index) + "[REDACTED]" + match.slice(index + value.length)
    })
  }
  return text
    .split(/\r?\n/)
    .filter((line) => !boilerplate.test(line) || limitPattern.test(line))
    .join("\n")
    .replace(filesystem, (path) => basename(path.replace(/\/$/, "")))
    .trim()
}

export function capJevText(text: string, max: number): string {
  if (text.length <= max) return text
  const boundary = text.slice(0, max - 1).search(/\s+\S*$/)
  return `${text.slice(0, boundary < 0 ? 0 : boundary).trimEnd()} …`
}

export function jevTaskFacts(prompt: string) {
  const files = /(?:\.?\.?\/|\b[\w.@-]+\/)[\w.@+/-]+(?:\.[A-Za-z0-9_-]{1,12})\b/g
  const repoNames = ["oh-my-openagent", "opencode", "opencode-with-claude", "meridian", "oc-codex-multi-auth", "pinion"]
  return {
    files_mentioned: new Set(prompt.match(files) ?? []).size,
    repos_mentioned: repoNames.filter((repo) => new RegExp(`\\b${repo}\\b`, "i").test(prompt)).length,
    has_exact_commands: /```|^\s*(?:\$\s+|(?:bun|npm|git|cargo|pytest|python|go|make|rg|tsc)\s+\S)/m.test(prompt),
    mentions_tests: /\b(?:tests?|testing|pytest|vitest|specs?|typecheck)\b/i.test(prompt),
    brief_bytes: Buffer.byteLength(prompt),
  }
}

export async function buildJevState(input: {
  readonly description: string
  readonly prompt: string
  readonly directory: string
}) {
  const resolved = await resolveJevBriefs(input.prompt, input.directory)
  let briefStatus: BriefStatus = resolved.status
  const briefs = resolved.texts
    .map((source) => {
      const sanitized = sanitizeJevText(source)
      if (sanitized.length > 8000 && briefStatus !== "unresolved") briefStatus = "truncated"
      return capJevText(sanitized, 8000)
    })
    .filter((text) => text.trim())
  const task: Record<string, string> = {}
  const title = capJevText(sanitizeJevText(input.description), 200)
  const prompt = capJevText(sanitizeJevText(input.prompt), 6000)
  if (title.trim()) task.title = title
  if (prompt.trim()) task.prompt = prompt
  if (briefs.length) task.brief = briefs.join("\n\n")
  const facts = jevTaskFacts(input.prompt)
  const battery = questions()
  const size = () =>
    Buffer.byteLength(JSON.stringify({ task, facts })) +
    Math.max(...Object.values(battery).map((question) => Buffer.byteLength(JSON.stringify(question)))) +
    2048
  while (size() > 32768 && task.brief) {
    if (briefStatus !== "unresolved") briefStatus = "truncated"
    const prefix = Buffer.from(task.brief)
      .subarray(0, Math.max(0, Buffer.byteLength(task.brief) - (size() - 32768) - 32))
      .toString("utf8")
    task.brief = prefix.replace(/\s+\S*$/, "").trimEnd()
    if (!task.brief) delete task.brief
  }
  if (size() > 32768) throw new RangeError("Task exceeds routing context")
  return {
    state: { task, facts },
    briefHash: createHash("sha256").update(input.prompt).digest("hex"),
    briefBytes: facts.brief_bytes,
    briefStatus,
    briefReasons: resolved.reasons,
  }
}
