import type { PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import type { V2PluginContext } from "./context-types"
import { V2UnsupportedOperationError } from "./unsupported-operation-error"

const todoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  id: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
})
const todosSchema = z.array(todoSchema)
const snapshotSchema = z.object({ todos: todosSchema, callID: z.string().optional() })
type TodoInput = z.input<typeof todoSchema>
type Todo = z.output<typeof todoSchema> & { readonly id: string }
type TodoWriter = (input: { readonly sessionID: string; readonly todos: TodoInput[] }) => Promise<void>
const writers = new WeakMap<PluginInput["client"], TodoWriter>()
const storageKey = (sessionID: string): string => `session-todos:${sessionID}`

function parseTodos(value: unknown): Todo[] {
  return todosSchema.parse(value).map((todo, index) => ({ ...todo, id: todo.id ?? `v2-todo-${index + 1}` }))
}

export async function writeSessionTodos(
  context: V2PluginContext,
  input: { readonly sessionID: string; readonly todos: unknown; readonly callID?: string },
): Promise<void> {
  const todos = parseTodos(input.todos)
  if (!context.storage) throw new V2UnsupportedOperationError("session.todo.update")
  const snapshot = snapshotSchema.nullish().parse(await context.storage.get(storageKey(input.sessionID)))
  const callID = input.callID ?? snapshot?.callID
  await context.storage.set(storageKey(input.sessionID), { todos, ...(callID === undefined ? {} : { callID }) })
}

export async function readSessionTodos(context: V2PluginContext, sessionID: string): Promise<Todo[]> {
  const stored = snapshotSchema.nullish().parse(await context.storage?.get(storageKey(sessionID)))
  const messages = await context.session.context({ sessionID })
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    for (const part of message.content.toReversed()) {
      if (part.type !== "tool" || part.name !== "todowrite") continue
      if (stored?.callID === part.id) return parseTodos(stored.todos)
      if (part.state.status !== "completed") continue
      const todos = parseTodos(part.state.input.todos)
      await context.storage?.set(storageKey(sessionID), { todos, callID: part.id })
      return todos
    }
  }
  return stored ? parseTodos(stored.todos) : []
}

export function bindTodoWriter(client: PluginInput["client"], context: V2PluginContext): void {
  writers.set(client, async (input) => {
    await readSessionTodos(context, input.sessionID)
    await writeSessionTodos(context, input)
  })
}

export function getV2TodoWriter(client: PluginInput["client"]): TodoWriter | undefined {
  return writers.get(client)
}
