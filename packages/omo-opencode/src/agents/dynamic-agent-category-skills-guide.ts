import type { AvailableCategory, AvailableSkill } from "./dynamic-agent-prompt-types"
import { ROUTINE_VERIFICATION_ROUTING_POLICY } from "../shared/routine-verification-routing-policy"

export function hasQuickCategory(categories: readonly AvailableCategory[]): boolean {
  return categories.some((category) => category.name === "quick")
}

function buildSkillsSection(skills: AvailableSkill[]): string {
  const builtinSkills = skills.filter((skill) => skill.location === "plugin")
  const customSkills = skills.filter((skill) => skill.location !== "plugin")

  const builtinNames = builtinSkills.map((skill) => skill.name).join(", ")
  const customNames = customSkills
    .map((skill) => {
      const source = skill.location === "project" ? "project" : "user"
      return `${skill.name} (${source})`
    })
    .join(", ")

  if (customSkills.length > 0 && builtinSkills.length > 0) {
    return `#### Available Skills (via \`skill\` tool)

**Built-in**: ${builtinNames}
**⚡ YOUR SKILLS (PRIORITY)**: ${customNames}

> User-installed skills OVERRIDE built-in defaults. ALWAYS prefer YOUR SKILLS when domain matches.
> Use the \`skill\` tool when you need a skill's full instructions.`
  }

  if (customSkills.length > 0) {
    return `#### Available Skills (via \`skill\` tool)

**⚡ YOUR SKILLS (PRIORITY)**: ${customNames}

> User-installed skills OVERRIDE built-in defaults. ALWAYS prefer YOUR SKILLS when domain matches.
> Use the \`skill\` tool when you need a skill's full instructions.`
  }

  if (builtinSkills.length > 0) {
    return `#### Available Skills (via \`skill\` tool)

**Built-in**: ${builtinNames}

> Use the \`skill\` tool when you need a skill's full instructions.`
  }

  return ""
}

export function buildCategorySkillsDelegationGuide(categories: AvailableCategory[], skills: AvailableSkill[]): string {
  if (categories.length === 0 && skills.length === 0) {
    return ""
  }

  const categoryRows = categories.map((category) => {
    const description = category.description || category.name
    return `- \`${category.name}\` - ${description}`
  })

  const skillsSection = buildSkillsSection(skills)

  return `### Category + Skills Delegation System

**task() combines categories and skills for optimal task execution.**

#### Available Categories (Domain-Optimized Models)

Each category is configured with a model optimized for that domain. Read the description to understand when to use it.

${categoryRows.join("\n")}

${hasQuickCategory(categories) ? ROUTINE_VERIFICATION_ROUTING_POLICY : ""}

${skillsSection}

---

### Delegation Selection Protocol

**STEP 1: Check the task tool's category routing description**
When active category routing is available, omit category or set category="auto". Jev selects quick, unspecified-low, deep-low, unspecified-high, visual-engineering, or writing, and detects UI work. In observe mode, auto dispatches the configured default; Jev only records its choice. When category routing is unavailable, select explicitly. Use subagent_type for a named agent.

**Explicit category fallback:** Use the selection protocol below if the tool description requires a category, a task result reports Jev was unavailable or fell back, the task needs a category outside auto's set (such as ultrabrain, artistry, deep-high, or a project category), a user, skill, or contract fixes the category, or you can name a specific reason auto would choose incorrectly. Honor intentional category diversity in team rosters.

When explicitly selecting:
- Read each category's description
- Match task requirements to category domain
- Select the category whose domain BEST fits the task

**STEP 2: Select skills when needed**
Follow mandatory skill workflows and explicit skill requests. Pass their names in \`load_skills\`. Omit the field for best-effort suggestions when Jev routing is active. Suggestions can be empty, unavailable, or incomplete. Pass \`[]\` to select no skills, or pass multiple names when they apply.

---

### Delegation Pattern

\`\`\`typescript
task(
  load_skills=["skill-1", "skill-2"],
  run_in_background=true,
  prompt="..."
)
\`\`\`

---

### Explicit Category Domain Matching (fallback)

When explicitly selecting, use the category that matches the task's domain. Active auto routing already detects UI work.

**ANY VISUAL DESIGN RELATION = ALWAYS \`visual-engineering\`. NO EXCEPTIONS.**

Any task with even a minor visual-design relationship (including UI, UX, CSS, styling, layout, animation, design systems, frontend components, screenshots, diagrams, visual polish, or presentation) MUST go to \`visual-engineering\`. Never delegate it to \`quick\`, \`unspecified-*\`, or any other category.

\`\`\`typescript
// CORRECT: Visual work → visual-engineering category
task(category="visual-engineering", load_skills=["frontend"], run_in_background=true, prompt="Redesign the sidebar layout with new spacing...")

// WRONG: Visual work in wrong category - WILL PRODUCE INFERIOR RESULTS
task(category="quick", load_skills=[], run_in_background=true, prompt="Redesign the sidebar layout with new spacing...")
\`\`\`

| Task Domain | MUST Use Category |
|---|---|
| Visual design, UI, styling, animations, layout, design systems | \`visual-engineering\` |
| Hard logic and architecture decisions | \`ultrabrain\` |
| 3D graphics, computer use, browser use, backend, logic, algorithms, CAPTCHA solving, multimodal, autonomous research + end-to-end implementation | \`deep-low\` |
| Any of the above whose central decision cannot be settled from evidence: a trade-off, a contract crossing a package boundary, a mechanism with no in-repo pattern, correctness argued from invariants | \`deep-high\` |
| Single-file typo, trivial config change | \`quick\` |

**When in doubt about category, it is almost never \`quick\` or \`unspecified-*\`. Match the domain.**`
}
