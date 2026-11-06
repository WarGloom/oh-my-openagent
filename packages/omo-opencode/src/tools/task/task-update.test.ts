import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { TaskObject } from "./types"
import { createTaskUpdateTool } from "./task-update"
import type { PluginInput } from "@opencode-ai/plugin"
import type { V2PluginContext } from "../../v2/context-types"
import { bindTodoWriter, readSessionTodos } from "../../v2/session-todos"

const TEST_SESSION_ID = "test-session-123"
const TEST_ABORT_CONTROLLER = new AbortController()
const TEST_CONTEXT = {
  sessionID: TEST_SESSION_ID,
  messageID: "test-message-123",
  agent: "test-agent",
  abort: TEST_ABORT_CONTROLLER.signal,
}

describe("task_update tool", () => {
  let tool: ReturnType<typeof createTaskUpdateTool>
  let testDir = ""

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "omo-task-update-"))
    tool = createTaskUpdateTool({
      sisyphus: {
        tasks: {
          storage_path: testDir,
        },
      },
    })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("update action", () => {
    test("updates the owner's todo when another session updates a task", async () => {
      // given
      const values = new Map<string, unknown>()
      const native = {
        storage: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: unknown) => {
            values.set(key, value)
          },
        },
        session: { context: async () => [] },
      } as unknown as V2PluginContext
      const ctx = {
        client: {
          session: {
            todo: async ({ path }: { path: { id: string } }) => ({ data: await readSessionTodos(native, path.id) }),
          },
        },
      } as unknown as PluginInput
      bindTodoWriter(ctx.client, native)
      const task: TaskObject = {
        id: "T-owner",
        subject: "Owned",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: "owner-A",
      }
      await Bun.write(join(testDir, `${task.id}.json`), JSON.stringify(task))
      values.set("session-todos:owner-A", { todos: [{ id: task.id, content: "Owned", status: "pending" }] })
      values.set("session-todos:caller-B", { todos: [{ id: "personal", content: "Personal", status: "pending" }] })
      const update = createTaskUpdateTool({ sisyphus: { tasks: { storage_path: testDir } } }, ctx)

      // when
      await update.execute({ id: task.id, status: "completed" }, { ...TEST_CONTEXT, sessionID: "caller-B" })

      // then
      expect((await readSessionTodos(native, "owner-A")).map(({ id, status }) => ({ id, status }))).toEqual([
        { id: task.id, status: "completed" },
      ])
      expect((await readSessionTodos(native, "caller-B")).map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "personal", status: "pending" },
      ])
    })

    test("updates task subject when provided", async () => {
      //#given
      const taskId = "T-test-123"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "Updated subject",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("task")
      expect(result.task.subject).toBe("Updated subject")
      expect(result.task.description).toBe("Test description")
    })

    test("updates task description when provided", async () => {
      //#given
      const taskId = "T-test-124"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Original description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        description: "Updated description",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.description).toBe("Updated description")
    })

    test("updates task status when provided", async () => {
      //#given
      const taskId = "T-test-125"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        status: "in_progress" as const,
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("task")
      expect(result.task.status).toBe("in_progress")
    })

    test("additively appends to blocks array without replacing", async () => {
      //#given
      const taskId = "T-test-126"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: ["T-existing-1"],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlocks: ["T-new-1", "T-new-2"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blocks).toContain("T-existing-1")
      expect(result.task.blocks).toContain("T-new-1")
      expect(result.task.blocks).toContain("T-new-2")
      expect(result.task.blocks.length).toBe(3)
    })

    test("avoids duplicate blocks when adding", async () => {
      //#given
      const taskId = "T-test-127"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: ["T-existing-1"],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlocks: ["T-existing-1", "T-new-1"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blocks).toContain("T-existing-1")
      expect(result.task.blocks).toContain("T-new-1")
      expect(result.task.blocks.length).toBe(2)
    })

    test("additively appends to blockedBy array without replacing", async () => {
      //#given
      const taskId = "T-test-128"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: ["T-blocker-1"],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlockedBy: ["T-blocker-2", "T-blocker-3"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blockedBy).toContain("T-blocker-1")
      expect(result.task.blockedBy).toContain("T-blocker-2")
      expect(result.task.blockedBy).toContain("T-blocker-3")
      expect(result.task.blockedBy.length).toBe(3)
    })

    test("merges metadata without replacing entire object", async () => {
      //#given
      const taskId = "T-test-129"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: {
          priority: "high",
          assignee: "alice",
        },
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        metadata: {
          priority: "low",
          tags: ["bug"],
        },
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.metadata.priority).toBe("low")
      expect(result.task.metadata.assignee).toBe("alice")
      expect(result.task.metadata.tags).toEqual(["bug"])
    })

    test("deletes metadata keys when set to null", async () => {
      //#given
      const taskId = "T-test-130"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: {
          priority: "high",
          assignee: "alice",
          tags: ["bug"],
        },
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        metadata: {
          assignee: null,
        },
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.metadata.priority).toBe("high")
      expect(result.task.metadata.assignee).toBeUndefined()
      expect(result.task.metadata.tags).toEqual(["bug"])
    })

    test("updates activeForm when provided", async () => {
      //#given
      const taskId = "T-test-131"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        activeForm: "implementing feature X",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.activeForm).toBe("implementing feature X")
    })

    test("updates owner when provided", async () => {
      //#given
      const taskId = "T-test-132"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        owner: "sisyphus",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.owner).toBe("sisyphus")
    })

    test("returns error when task not found", async () => {
      //#given
      const args = {
        id: "T-nonexistent",
      }

      //#when
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
      expect(result.error).toBe("task_not_found")
    })

    test("returns error for invalid task ID format", async () => {
      //#given
      const args = {
        id: "invalid-id",
      }

      //#when
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
      expect(result.error).toBe("invalid_task_id")
    })

    test("persists changes to file storage", async () => {
      //#given
      const taskId = "T-test-133"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "Updated subject",
      }
      await tool.execute(args, TEST_CONTEXT)

      //#then
      const savedContent = await Bun.file(taskPath).text()
      const savedTask = JSON.parse(savedContent)
      expect(savedTask.subject).toBe("Updated subject")
    })

    test("updates multiple fields in single call", async () => {
      //#given
      const taskId = "T-test-134"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Original description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "New subject",
        description: "New description",
        status: "in_progress" as const,
        owner: "alice",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.subject).toBe("New subject")
      expect(result.task.description).toBe("New description")
      expect(result.task.status).toBe("in_progress")
      expect(result.task.owner).toBe("alice")
    })
  })
})
