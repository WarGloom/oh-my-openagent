import { z } from "zod"

const row = z.object({
  event: z.string(),
  decision_id: z.string(),
  replaced_decision_id: z.string().optional(),
  child_session_id: z.string().optional().nullable(),
  category: z.string().optional(),
  orchestrator_category: z.string().optional(),
  chosen_category: z.string().optional().nullable(),
  producing_model: z.string().optional().nullable(),
  classification: z.string().optional(),
  timestamp: z.string(),
})
const tasks = new Map<
  string,
  {
    category?: string
    model?: string
    child?: string
    repair: number
    rework: number
    replaced: boolean
    report?: { type?: string; at: string }
  }
>()
function task(id: string) {
  const value = tasks.get(id) ?? { repair: 0, rework: 0, replaced: false }
  tasks.set(id, value)
  return value
}
for (const file of process.argv.slice(2)) {
  for (const line of (await Bun.file(file).text()).split("\n")) {
    if (!line.trim()) continue
    const entry = row.parse(JSON.parse(line))
    const value = task(entry.decision_id)
    if (entry.child_session_id) value.child = entry.child_session_id
    switch (entry.event) {
      case "dispatch":
        value.category ??= entry.category
        break
      case "decision":
        value.category = entry.chosen_category ?? entry.orchestrator_category
        break
      case "report":
        if (!value.report || value.report.at > entry.timestamp)
          value.report = { type: entry.classification, at: entry.timestamp }
        value.model ??= entry.producing_model ?? undefined
        break
      case "outcome":
        value.model ??= entry.producing_model ?? undefined
        break
      case "round":
        if (entry.classification === "repair") value.repair++
        if (
          entry.classification === "repair" ||
          entry.classification === "early_stop" ||
          entry.classification === "brief_correction"
        )
          value.rework++
        break
      case "replacement":
        if (entry.replaced_decision_id) task(entry.replaced_decision_id).replaced = true
        break
    }
  }
}
const groups = new Map<
  string,
  {
    category: string
    producing_model: string
    tasks: number
    zero: number
    repairs: number
    replaced: number
    first_not_delivered: number
  }
>()
for (const value of tasks.values()) {
  if (!value.child || !value.report) continue
  const category = value.category ?? "unknown"
  const producing_model = value.model ?? "unknown"
  const key = JSON.stringify([category, producing_model])
  const group = groups.get(key) ?? {
    category,
    producing_model,
    tasks: 0,
    zero: 0,
    repairs: 0,
    replaced: 0,
    first_not_delivered: 0,
  }
  group.tasks++
  group.zero += Number(value.rework === 0)
  group.repairs += value.repair
  group.replaced += Number(value.replaced)
  group.first_not_delivered += Number(value.report.type === "not_delivered")
  groups.set(key, group)
}
for (const { category, producing_model, tasks, zero, repairs, replaced, first_not_delivered } of groups.values())
  console.log(
    JSON.stringify({
      category,
      producing_model,
      tasks,
      zero_rework_share: zero / tasks,
      mean_repair_rounds: repairs / tasks,
      replaced_share: replaced / tasks,
      first_not_delivered_share: first_not_delivered / tasks,
    }),
  )
