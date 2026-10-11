# Prompt Guide

Reference when writing prompts to AI assistants. Not loaded automatically — reference on demand (`@PROMPT_GUIDE.md`).

## Prompt structure

Every non-trivial prompt should include:

- **Role / Context** — background the agent needs and perspective to take.
- **Task** — what to produce, stated specifically and measurably.
- **Constraints** — language, framework, existing patterns, size limits.
- **Anti-goals** — what output must *not* do. Prevents gold-plating and scope creep.
- **Output format** — code only, structured list, diff, explanation + code, etc.

## Patterns by context

| Context | Key ingredients |
|---|---|
| **Start a feature** | Project context, acceptance criteria, constraints, anti-goals — ask for a plan or acceptance criteria before any code |
| **Implement from a plan** | Paste the written plan or issue, name language/framework, cite existing patterns, list out-of-scope files, mandate red/green/refactor, ask for minimal impl |
| **Review code** | Skeptical review; tag `BLOCKING` / `IMPORTANT` / `NIT`; cover security, error handling, test gaps, readability, TDD order, hardcoded values; structured list not rewrites |
| **Debug** | Root cause diagnosis (not guesses); one proposed fix with explanation |
| **Architecture** | Three approaches with tradeoffs, risks, edge cases; recommendation; confirm before impl |

## Anti-patterns

- **Vague goal** — "improve the code" with no criteria
- **Missing constraints** — no language/framework/pattern specified
- **No anti-goals** — implicit what should not change
- **Stacked goals** — multiple unrelated tasks; split them
- **Implicit context** — assuming agent knows which file/decision is meant
- **Conversational tone** — "hey could you maybe try…" instead of a precise request
- **No exit condition** — open-ended with no stopping point
- **Skipping TDD** — asking for impl without mandating red/green/refactor
- **Severity self-censorship in reviews** — "be nice"; ask for honest severity tagging instead

## AI tooling & automation

### Reusable commands

Repeatable fixed-pattern actions (commit+push+PR, test, format, changelog) → scripts in the repo (e.g. a shell script or a package script) or your assistant's saved commands. Reviewable, improvable, not memory-dependent.

### Workflows

Multi-step tasks with domain knowledge → reusable workflows or saved instructions your assistant can load. When writing one:

- Trigger description for model, not human summary.
- Goal + constraints; avoid step-by-step that breaks on context change.
- Include scripts, libraries, and a Gotchas section that grows over time.

### Subagents

Delegate when tasks are independent/parallel or research shouldn't pollute impl context. Skip for < ~3 tool calls. Read-only analysis → smaller/faster model. Side effects → worktree isolation.

### Hooks for automated enforcement

Enforce mechanical standards (format, lint, audit, test) via hooks, not chat reminders. After-tool hooks catch problems at point of change; session-stop hooks enforce DoD gates.
