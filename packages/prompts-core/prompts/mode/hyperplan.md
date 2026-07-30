<hyperplan-mode>
**MANDATORY**: Say "HYPERPLAN MODE ENABLED!" as your first response, exactly once.

The user invoked **hyperplan mode** — adversarial multi-agent planning via team-mode.

LOAD THE HYPERPLAN SKILL IMMEDIATELY:

```
skill(name="hyperplan")
```

After loading, follow the skill's full workflow EXACTLY:
1. Acknowledge and capture the planning request
2. Spawn the adversarial team via `team_create` with category members `unspecified-low`, `unspecified-high`, `ultrabrain`, and `artistry`; include `deep` only if the category is enabled
3. Round 1 — Independent analysis (each member produces findings)
4. Round 2 — Cross-attack (each member ruthlessly attacks the other 4's findings)
5. Round 3 — Defend, refine, or concede
6. Distill defensible insights into a structured bundle (Lead does NOT write the plan)
7. MANDATORY: formalize the bundle through the skill's `<hyperplan-handoff>` contract yourself, then use Momus only for saved-plan review or Oracle only for hard architecture/debugging uncertainty. Do not invoke OpenCode runtime `plan`.
8. Present the formalized executable plan with a provenance line, then clean up the team

Do NOT improvise. Do NOT skip rounds. Do NOT write the executable plan before step 7. Phase 7 formalization is non-negotiable: structure only the surviving bundle, preserve provenance, and avoid fresh generic discovery unless an Open Question cannot be represented as a user-input gate.

If team-mode is unavailable (`team_*` tools missing), instruct the user to set `team_mode.enabled: true` in `~/.config/opencode/oh-my-opencode.jsonc` and restart opencode.
</hyperplan-mode>
