import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const installer = readFileSync(new URL("./install-v2-local.sh", import.meta.url), "utf8")
const activation = installer.match(/^printf '%s' "\$password" \|[^\n]*\n[\s\S]*?^' \|\| fail [^\n]+/m)?.[0]
const repo = resolve(import.meta.dir, "..")
const bun = Bun.which("bun")

type Reply = { readonly status: number; readonly body: string }
const agents = ["sisyphus", "hephaestus", "prometheus", "atlas"].map((id) => ({ id }))
const ready = { status: 200, body: JSON.stringify({ data: agents }) }
const credential = "fixture-private-credential"

async function runActivation(replies: readonly Reply[], cwd = repo) {
  if (!activation) throw new Error("Installer activation block missing")
  if (!bun) throw new Error("Bun executable missing")
  // Only the embedded client runs. The shell installer and live network are never executed.
  const fixture = `
    const replies = ${JSON.stringify(replies)}
    let requests = 0
    let deadline
    let requestedDeadline
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    AbortSignal.timeout = (ms) => {
      requestedDeadline = ms
      deadline = timeout(1000)
      return deadline
    }
    globalThis.fetch = async (input, options) => {
      const url = new URL(input)
      if (url.origin !== "http://127.0.0.1:49375" ||
          url.searchParams.get("location[directory]") !== "/fixture/workspace") {
        throw new Error("Unexpected activation target")
      }
      if (new Headers(options.headers).get("authorization") !==
          "Basic " + btoa("opencode:${credential}")) {
        return new Response("unauthorized", { status: 401 })
      }
      options.signal.throwIfAborted()
      requests++
      if (url.pathname.startsWith("/api/rpc/")) {
        return Response.json({ _tag: "RpcError", type: "rpc.unavailable" }, { status: 400 })
      }
      if (url.pathname !== "/api/agent") throw new Error("Unexpected activation route")
      const reply = replies[Math.min(requests - 1, replies.length - 1)]
      return new Response(reply.body, { status: reply.status })
    }
    process.on("exit", () => console.error("FIXTURE:" + JSON.stringify({
      requests, requestedDeadline, expired: deadline?.aborted, cwd: process.cwd(),
    })))
  `
  const command = activation.replace(" -e '", " -e '" + fixture)
  if (command === activation) throw new Error("Activation fixture injection failed")
  const child = Bun.spawn(
    [
      "/bin/bash",
      "-c",
      `
    repo=$1
    ws=/fixture/workspace
    password=$(</dev/stdin)
    fail() { exit 1; }
    ${command}
  `,
      "activation",
      repo,
    ],
    {
      cwd,
      env: { PATH: `${dirname(bun)}:/usr/bin:/bin` },
      stdin: new Blob([credential]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stdout + stderr).not.toContain(credential)
  expect(stdout + stderr).not.toContain(btoa(`opencode:${credential}`))
  expect(child.signalCode).toBeNull()
  expect(stderr).toContain('"requestedDeadline":120000')
  return { code, stdout, stderr }
}

test("accepts cold delayed activation only after all four primary agents load", async () => {
  // given a cold catalog, then three agents, then all four
  const replies = [
    { status: 200, body: JSON.stringify({ data: [] }) },
    { status: 200, body: JSON.stringify({ data: agents.slice(0, 3) }) },
    ready,
  ]
  // when the shipped client checks readiness
  const result = await runActivation(replies)
  // then it accepts the complete catalog before the deadline
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("primary agents 4")
  expect(result.stderr).toContain('"requests":3')
  expect(result.stderr).toContain('"expired":false')
})

test.each([
  ["authentication rejection", { status: 401, body: credential }],
  ["server failure", { status: 500, body: credential }],
  ["invalid JSON", { status: 200, body: credential }],
  ["invalid envelope", { status: 200, body: '{"data":{}}' }],
  ["invalid agent", { status: 200, body: '{"data":[null]}' }],
] as const)("fails immediately on %s", async (_name, reply) => {
  // given an actual error followed by a catalog that would otherwise succeed
  // when the shipped client checks readiness
  const result = await runActivation([reply, ready])
  // then it fails without retrying or disclosing credentials
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain('"requests":1')
  expect(result.stderr).toContain('"expired":false')
})

test("fails at the shared deadline when the plugin never loads", async () => {
  // given a valid catalog that permanently lacks the plugin
  // when the shipped client exhausts its deadline (accelerated only in this child)
  const result = await runActivation([{ status: 200, body: '{"data":[]}' }])
  // then the client exits itself at the deadline, without the child watchdog killing it
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain('"expired":true')
})

test("resolves activation dependencies from the repo when invoked from a foreign cwd", async () => {
  // given a caller outside the repository
  // when the actual activation invocation runs from that directory
  const result = await runActivation([ready], "/")
  // then the client resolves zod and accepts the complete catalog in the repository
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("primary agents 4")
  expect(result.stderr).toContain(`"cwd":${JSON.stringify(repo)}`)
})
