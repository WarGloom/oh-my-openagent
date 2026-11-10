import type { Todo } from "./types"

function isIncomplete(todo: Todo): boolean {
  return (
    todo.status !== "completed" && todo.status !== "cancelled" && todo.status !== "blocked" && todo.status !== "deleted"
  )
}

export function getIncompleteCount(todos: readonly Todo[]): number {
  return todos.filter(isIncomplete).length
}

export function getActionableTodos(todos: readonly Todo[]): Todo[] {
  return todos.filter((todo) => isIncomplete(todo) && todo.metadata?.waiting_on !== "user")
}
