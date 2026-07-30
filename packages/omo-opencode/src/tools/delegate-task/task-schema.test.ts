/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createDelegateTask } from "./tools"

describe("createDelegateTask schema", () => {
	test("#given category arg #when tool is created #then category accepts any string", () => {
		//#given
		const toolDefinition = createDelegateTask({ manager: {} as never, client: {} as never, directory: "/tmp/test" })

		//#when
		const categorySchema = unsafeTestValue<{
			def: {
				type: string
				innerType: {
					def: { type: string }
				}
			}
		}>(toolDefinition.args.category)

		//#then
		expect(categorySchema.def.type).toBe("optional")
		expect(categorySchema.def.innerType.def.type).toBe("string")
	})

	test("#given task description #when tool is created #then task description separates categories from direct subagents", () => {
		//#given
		const toolDefinition = createDelegateTask({ manager: {} as never, client: {} as never, directory: "/tmp/test" })

		//#when
		const description = toolDefinition.description

		//#then
		expect(description).toContain("subagent_type: Use specific agent directly")
		expect(description).toContain('For implementation/deep-worker tasks, use category="deep" instead of subagent_type="hephaestus".')
		expect(description).toContain("task_id: Continuation session id")
		expect(description).toContain("Sisyphus-Junior")
		expect(description).toContain("Available agent types:")
		expect(description).not.toContain("- hephaestus:")
		expect(description).not.toContain("- plan:")
		expect(description).toContain("- sisyphus-junior: Category-spawned general executor")
		expect(description).not.toContain("- sisyphus:")
		expect(description).not.toContain("- prometheus:")
	})

	test("#given available subagent names omitted #when tool is created #then registered custom agent names remain valid", () => {
		//#given
		const toolDefinition = createDelegateTask({ manager: {} as never, client: {} as never, directory: "/tmp/test" })

		//#when
		const subagentSchema = unsafeTestValue<{
			def: {
				type: string
				innerType: {
					def: { type: string }
				}
			}
		}>(toolDefinition.args.subagent_type)

		//#then
		expect(subagentSchema.def.type).toBe("optional")
		expect(subagentSchema.def.innerType.def.type).toBe("string")
	})

	test("#given available subagent names include disabled direct agents #when tool is created #then they are filtered from the schema", () => {
		//#given
		const toolDefinition = createDelegateTask({
			manager: {} as never,
			client: {} as never,
			directory: "/tmp/test",
			availableSubagentNames: ["oracle", "plan", "hephaestus", "Hephaestus - Deep Agent", "explore"],
		})

		//#when
		const subagentSchema = unsafeTestValue<{
			def: {
				type: string
				innerType: {
					def: { type: string; entries?: Record<string, string> }
				}
			}
		}>(toolDefinition.args.subagent_type)

		//#then
		expect(subagentSchema.def.innerType.def.entries).not.toHaveProperty("plan")
		expect(subagentSchema.def.innerType.def.entries).not.toHaveProperty("hephaestus")
		expect(subagentSchema.def.innerType.def.entries).not.toHaveProperty("Hephaestus - Deep Agent")
		expect(subagentSchema.def.innerType.def.entries).toHaveProperty("oracle", "oracle")
	})

	test("#given task schema #when describing async mode #then it names background task ids explicitly", () => {
		//#given
		const toolDefinition = createDelegateTask({ manager: {} as never, client: {} as never, directory: "/tmp/test" })

		//#when
		const runInBackgroundSchema = unsafeTestValue<{ description?: string }>(toolDefinition.args.run_in_background)

		//#then
		expect(runInBackgroundSchema.description).toContain("background task ID")
		expect(runInBackgroundSchema.description).toContain("bg_")
		expect(runInBackgroundSchema.description).toContain("background_output")
		expect(runInBackgroundSchema.description).not.toContain("returns task_id")
	})
})

export {}
