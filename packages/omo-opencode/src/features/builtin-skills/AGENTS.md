# src/features/builtin-skills/ — Compatibility Re-export

**Generated:** 2026-08-24

## OVERVIEW

The built-in skill catalog has been extracted into `@oh-my-opencode/skills-loader-core`. This directory is retained only for compatibility with older imports and should not contain independent skill implementations.

The canonical implementation, types, tests, and skill resources live in:

```
packages/skills-loader-core/src/features/builtin-skills/
```

See [the canonical AGENTS.md](../../../../skills-loader-core/src/features/builtin-skills/AGENTS.md) for the complete skill catalog, structure, browser-variant selection, and contribution guidance.

## STRUCTURE

```
builtin-skills/
├── AGENTS.md       # This compatibility note
├── skills.ts       # Re-exports the canonical builtin skill factory
└── skills/
    └── index.ts    # Re-exports the canonical skill barrel
```

## IMPORTS

Use the package exports instead of importing from this directory:

```typescript
import { createBuiltinSkills } from "@oh-my-opencode/skills-loader-core/builtin-skills"
import { resolveActiveBuiltinSkills } from "@oh-my-opencode/skills-loader-core/builtin-skills"
```

For individual skills, use:

```typescript
import { teamModeSkill } from "@oh-my-opencode/skills-loader-core/builtin-skills/skills/index"
```

Do not add new skill implementations, resources, or duplicate tests under `packages/omo-opencode/src/features/builtin-skills/`. Add them to `packages/skills-loader-core/src/features/builtin-skills/` and update its canonical documentation.
