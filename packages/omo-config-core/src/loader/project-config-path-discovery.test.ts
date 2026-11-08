import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { parsePasswdHome } from "./account-home"
import { findProjectConfigPathsFarthestFirst, MAX_PROJECT_CONFIG_DIRECTORY_DEPTH } from "./paths"
import type { OmoConfigReadFileSystem } from "./types"

function projectConfigPath(directory: string): string {
  return join(directory, ".omo", "omo.jsonc")
}

function makeProjectFileSystem(
  configDirectories: readonly string[],
  symlinkedOmoDirectories: readonly string[] = [],
): OmoConfigReadFileSystem {
  const configPaths = configDirectories.map(projectConfigPath)
  const existingPaths = new Set([
    ...configDirectories.map((directory) => join(directory, ".omo")),
    ...configPaths,
    ...symlinkedOmoDirectories,
  ])
  const symlinkedPaths = new Set(symlinkedOmoDirectories)

  return {
    existsSync: (path: string): boolean => existingPaths.has(path),
    lstatSync: (path: string) => ({ isSymbolicLink: (): boolean => symlinkedPaths.has(path) }),
    readFileSync: (): string => "{}",
  }
}

function nestedPath(rootDir: string, depth: number): string {
  let path = rootDir
  for (let index = 0; index < depth; index += 1) path = join(path, `level-${index}`)
  return path
}

describe("findProjectConfigPathsFarthestFirst", () => {
  test("#given cwd outside HOME and a grandparent config #when resolving project paths #then it is discovered", () => {
    // given
    const homeDir = resolve("/home/alice")
    const configDir = resolve("/opt/work")
    const cwd = join(configDir, "project", "sub")
    const fileSystem = makeProjectFileSystem([configDir])

    // when
    const paths = findProjectConfigPathsFarthestFirst(cwd, homeDir, fileSystem)

    // then
    expect(paths).toEqual([projectConfigPath(configDir)])
  })

  test("#given nested project configs inside HOME #when resolving project paths #then they are farthest-first", () => {
    // given
    const homeDir = resolve("/home/alice")
    const configDirectories = [
      join(homeDir, "work"),
      join(homeDir, "work", "project"),
      join(homeDir, "work", "project", "src"),
    ]
    const cwd = configDirectories[2]
    const fileSystem = makeProjectFileSystem(configDirectories)

    // when
    const paths = findProjectConfigPathsFarthestFirst(cwd, homeDir, fileSystem)

    // then
    expect(paths).toEqual(configDirectories.map(projectConfigPath))
  })

  test("#given HOME has a user config #when resolving project paths #then HOME is excluded", () => {
    // given
    const homeDir = resolve("/home/alice")
    const projectDir = join(homeDir, "work", "project")
    const fileSystem = makeProjectFileSystem([homeDir, projectDir])

    // when
    const paths = findProjectConfigPathsFarthestFirst(join(projectDir, "src"), homeDir, fileSystem)

    // then
    expect(paths).toEqual([projectConfigPath(projectDir)])
  })

  test("#given overridden HOME outside the account home #when resolving project paths #then the account user config is excluded", () => {
    // given
    const configuredHomeDir = resolve("/tmp/isolated-home")
    const accountHomeDir = "/home/alice"
    const projectDir = join(accountHomeDir, "work", "project")
    const fileSystem = makeProjectFileSystem([accountHomeDir, projectDir])

    // when
    const paths = findProjectConfigPathsFarthestFirst(
      join(projectDir, "src"),
      configuredHomeDir,
      fileSystem,
      accountHomeDir,
    )

    // then
    expect(paths).toEqual([projectConfigPath(projectDir)])
  })

  test("#given a symlinked project .omo directory #when resolving project paths #then it is refused", () => {
    // given
    const projectDir = resolve("/opt/work/project")
    const omoDir = join(projectDir, ".omo")
    const fileSystem = makeProjectFileSystem([projectDir], [omoDir])

    // when
    const paths = findProjectConfigPathsFarthestFirst(projectDir, resolve("/home/alice"), fileSystem)

    // then
    expect(paths).toEqual([])
  })

  test("#given no project configs #when resolving project paths #then it returns an empty list", () => {
    expect(
      findProjectConfigPathsFarthestFirst(
        resolve("/opt/work/project"),
        resolve("/home/alice"),
        makeProjectFileSystem([]),
      ),
    ).toEqual([])
  })

  test("#given cwd exceeds the maximum walk depth #when resolving project paths #then the walk is bounded", () => {
    // given
    const rootDir = resolve("/opt")
    const homeDir = resolve("/home/alice")
    const checkedDirectories: string[] = []
    const fileSystem: OmoConfigReadFileSystem = {
      existsSync: (path: string): boolean => {
        if (path.endsWith(join(".omo", "omo.jsonc"))) checkedDirectories.push(dirname(dirname(path)))
        return false
      },
      readFileSync: (): string => "{}",
    }

    // when
    const paths = findProjectConfigPathsFarthestFirst(
      nestedPath(rootDir, MAX_PROJECT_CONFIG_DIRECTORY_DEPTH + 1),
      homeDir,
      fileSystem,
    )

    // then
    expect(paths).toEqual([])
    expect(checkedDirectories).toHaveLength(MAX_PROJECT_CONFIG_DIRECTORY_DEPTH)
    expect(checkedDirectories).not.toContain(rootDir)
  })
})

// POSIX-only: the account-home split comes from Bun reporting $HOME as the passwd home; win32 never reads passwd.
test.skipIf(process.platform === "win32")(
  "resolveOmoConfigPaths stops at the resolved account home when HOME differs",
  () => {
    const source = `
    import { mock } from "bun:test"
    mock.module("./account-home", () => ({ resolveAccountHomeDir: () => "/home/alice" }))
    const { resolveOmoConfigPaths } = await import("./paths")
    const configs = new Set(["/home/alice/.omo/omo.jsonc", "/home/alice/work/.omo/omo.jsonc"])
    const fileSystem = { existsSync: (path) => configs.has(path), readFileSync: () => "{}" }
    console.log(JSON.stringify(resolveOmoConfigPaths({ cwd: "/home/alice/work", env: { HOME: "/isolated-home" }, fileSystem })))
  `
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", source],
      cwd: import.meta.dir,
      env: { ...process.env, HOME: "/isolated-home" },
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { path: "/isolated-home/.omo/omo.jsonc", scope: "user" },
      { path: "/home/alice/work/.omo/omo.jsonc", scope: "project" },
    ])
  },
)

test("passwd home lookup selects the exact uid and rejects missing entries", () => {
  const passwd =
    "root:x:0:0:root:/root:/bin/sh\nalice:x:1001:1001:Alice:/home/alice:/bin/sh\ninvalid:x::0::/wrong:/bin/sh"
  expect(parsePasswdHome(passwd, 1001)).toBe("/home/alice")
  expect(parsePasswdHome(passwd, 0)).toBe("/root")
  expect(parsePasswdHome(passwd, 100)).toBeUndefined()
})
