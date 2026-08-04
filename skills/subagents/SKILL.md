---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Spawn and manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and any task-specific options. At most eight subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Subagents auto-compact their context when it fills. A run showing ~100% context usage is NOT stuck and NOT doomed — it will compact and continue. Do not cancel a subagent for high context usage alone; cancel only for genuine problems (wrong direction, no progress across multiple checks, task obsolete).

Results return automatically. After spawning, continue useful parent work instead of immediately waiting. Spawn independent tasks separately when they can run in parallel, and use `subagent_wait` only when their results are required before proceeding.
