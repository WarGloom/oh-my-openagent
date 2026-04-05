import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createCiTestPlan } from "./run-ci-tests"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

describe("createCiTestPlan", () => {
  test("keeps runtime-fallback mock.module tests isolated at file level", async () => {
    const root = mkdtempSync(join(tmpdir(), "omo-ci-plan-"))
    tempDirs.push(root)

    mkdirSync(join(root, "src", "hooks", "runtime-fallback"), { recursive: true })
    mkdirSync(join(root, "bin"), { recursive: true })
    mkdirSync(join(root, "script"), { recursive: true })
    writeFileSync(
      join(root, "src", "hooks", "runtime-fallback", "index.test.ts"),
      'import { test, mock } from "bun:test"\nmock.module("./dep", () => ({}))\ntest("a", () => {})\n',
    )
    writeFileSync(
      join(root, "src", "hooks", "runtime-fallback", "dispose.test.ts"),
      'import { test, mock } from "bun:test"\nmock.module("./dep", () => ({}))\ntest("b", () => {})\n',
    )

    const plan = await createCiTestPlan(root)

    expect(plan.isolatedTestTargets).toContain("src/hooks/runtime-fallback/index.test.ts")
    expect(plan.isolatedTestTargets).toContain("src/hooks/runtime-fallback/dispose.test.ts")
    expect(plan.isolatedTestTargets).not.toContain("src/hooks/runtime-fallback")
  })
})
