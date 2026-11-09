import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildJevState, capJevText, jevTaskFacts, sanitizeJevText } from "./jev-router-state"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("study Jev state", () => {
  test("replaces filesystem paths with basenames without merging words", () => {
    expect(sanitizeJevText("Read /home/user/project/brief.md then src/module/parser.ts; keep words.")).toBe(
      "Read brief.md then parser.ts; keep words.",
    )
    expect(sanitizeJevText("Read ./brief.md and ../other/file.ts next.")).toBe("Read brief.md and file.ts next.")
    expect(sanitizeJevText("allowed tools: read\nMust not change build wiring\napi_key=private-value")).toBe(
      "Must not change build wiring\napi_key=[REDACTED]",
    )
  })

  test("computes facts from the original prompt with the study regexes", () => {
    const prompt = "opencode and meridian: src/a.ts src/a.ts src/b.ts\nbun test specs"
    expect(jevTaskFacts(prompt)).toEqual({
      files_mentioned: 2,
      repos_mentioned: 2,
      has_exact_commands: true,
      mentions_tests: true,
      brief_bytes: Buffer.byteLength(prompt),
    })
  })

  test("reads a referenced brief at routing time and caps it on whitespace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-state-"))
    directories.push(directory)
    const text = "bounded change ".repeat(700)
    writeFileSync(join(directory, "brief.md"), text)
    const first = await buildJevState({
      description: "Implement change",
      prompt: "Read brief.md and implement the plan",
      directory,
    })
    expect(first.state.task).toEqual({
      title: "Implement change",
      prompt: "Read brief.md and implement the plan",
      brief: capJevText(text.trim(), 8000),
    })
    expect(first.state.task.brief?.length).toBeLessThanOrEqual(8000)
    writeFileSync(join(directory, "brief.md"), "Changed current file")
    const second = await buildJevState({
      description: "Implement change",
      prompt: "Read brief.md and implement the plan",
      directory,
    })
    expect(second.state.task.brief).toBe("Changed current file")
    expect(second.briefHash).toBe(first.briefHash)
  })

  test("omits missing briefs and preserves capped title and prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-state-"))
    directories.push(directory)
    const description = "title ".repeat(100)
    const prompt = "Read missing-plan.md then " + "implement bounded change ".repeat(400)
    const built = await buildJevState({ description, prompt, directory })
    expect(built.state.task).toEqual({ title: capJevText(description.trim(), 200), prompt: capJevText(prompt, 6000) })
    expect(built.briefBytes).toBe(Buffer.byteLength(prompt))
    expect(built.briefStatus).toBe("unresolved")
    expect(built.briefReasons).toEqual(["missing"])
  })

  test("confines absolute and relative references to the parent directory independently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-root-"))
    directories.push(directory)
    mkdirSync(join(directory, "nested"))
    writeFileSync(join(directory, "nested", "absolute-plan.md"), "Absolute inside")
    writeFileSync(join(directory, "relative-plan.md"), "Relative to parent")
    const built = await buildJevState({
      description: "Change",
      prompt: `Read ${join(directory, "nested", "absolute-plan.md")} and relative-plan.md`,
      directory,
    })
    expect(built.state.task.brief).toBe("Absolute inside\n\nRelative to parent")
    expect(built.briefStatus).toBe("resolved")
    expect(Object.keys(built.state)).toEqual(["task", "facts"])
    expect(Object.keys(built.state.task)).toEqual(["title", "prompt", "brief"])
  })

  test("records outside-root, escaping symlink and unreadable references without including their text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-root-"))
    const outside = mkdtempSync(join(tmpdir(), "jev-outside-"))
    directories.push(directory, outside)
    writeFileSync(join(outside, "external-plan.md"), "OUTSIDE PRIVATE CONTENT")
    symlinkSync(join(outside, "external-plan.md"), join(directory, "linked-plan.md"))
    writeFileSync(join(directory, "unreadable-plan.md"), "UNREADABLE PRIVATE CONTENT")
    chmodSync(join(directory, "unreadable-plan.md"), 0)
    const built = await buildJevState({
      description: "Change",
      prompt: `Read ${join(outside, "external-plan.md")} linked-plan.md unreadable-plan.md and ~/.omo/plan.md`,
      directory,
    })
    expect(built.state.task.brief).toBeUndefined()
    expect(built.briefStatus).toBe("unresolved")
    expect(built.briefReasons.sort()).toEqual(["outside_root", "unreadable"])
  })

  test("distinguishes no reference from truncated, nonregular and oversized briefs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-root-"))
    directories.push(directory)
    expect((await buildJevState({ description: "Change", prompt: "Implement code", directory })).briefStatus).toBe(
      "none",
    )
    writeFileSync(join(directory, "long-plan.md"), "word ".repeat(2000))
    expect((await buildJevState({ description: "Change", prompt: "Read long-plan.md", directory })).briefStatus).toBe(
      "truncated",
    )
    mkdirSync(join(directory, "directory-plan.md"))
    writeFileSync(join(directory, "huge-plan.md"), "x".repeat(1024 * 1024 + 1))
    const built = await buildJevState({
      description: "Change",
      prompt: "Read directory-plan.md and huge-plan.md",
      directory,
    })
    expect(built.briefReasons.sort()).toEqual(["not_regular", "oversized"])
    expect(built.state.task.brief).toBeUndefined()
  })
})
