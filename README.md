# Matthew's Pi configuration

A portable, public subset of Matthew's configuration for
[Pi](https://github.com/badlogic/pi-mono). It packages the stable pieces that are
useful to coworkers without publishing authentication, model, trust, session, or
machine-specific state.

This setup is based on
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup), with
additional extensions and local adaptations. See [CREDITS.md](CREDITS.md).

## Included

- `ask-user`: structured multiple-choice questions
- `background-terminals`: long-running shell commands with status and output UI
- `copy-all`: copy the current response or transcript content
- `file-search`: first-class `fd` and `rg` tools with portable binary discovery
- `git-info` and `model-info`: status-line context
- `subagents`: managed Pi, Codex, Claude, and Cursor CLI backends
- `ui-customization`: the configured footer and interface customizations
- `workflows`: multi-stage agent workflows and their dashboard
- shared support modules, matching skills, and the GitHub Dark Default theme

Private configuration is deliberately absent. In particular, this package does
not contain provider credentials, model catalogs, settings, trust decisions,
sessions, runtime history, workflow state, notification integrations, proxy
configuration, screenshots, or caches.

## Security

Treat this repository as trusted code only after reviewing it:

- Pi extensions execute arbitrary code with the permissions of the Pi process.
- The background-terminal extension runs shell commands.
- Subagent backends launch external CLIs. Those processes may inherit configured
  permissions, credentials, environment variables, and access to the working
  directory.
- Project trust is not a sandbox. Review both this source and the code in any
  project before granting trust or allowing tools to make changes.

For stronger isolation, run Pi in an operating-system sandbox, container, or
virtual machine with only the files and credentials needed for the task.

The Pi 0.80.x dependency stack currently brings two transitive npm advisories
through `@earendil-works/pi-coding-agent`'s embedded shrinkwrap:
`brace-expansion` (high) and `protobufjs` (moderate). There is no honest local
root-lockfile fix because `npm ci` installs the versions pinned by that upstream
shrinkwrap even when a root lock record or override says otherwise. Update Pi
when upstream publishes a compatible fixed release, then rerun
`npm audit --omit=dev`.

## Write your own AGENTS.md

This package technically loads without an `AGENTS.md`, but it works best with a
thoughtfully written `~/.pi/agent/AGENTS.md`. That file gives the agent durable
context about how to collaborate with you across projects. It remains
gitignored, excluded from this repository, and private to your local setup.
Individual project repositories can add narrower `AGENTS.md` rules for their
own architecture, workflows, and safety boundaries.

A useful personal file usually covers:

1. Who you are and the expertise relevant to your work.
2. How you prefer the agent to work, reason, report progress, and communicate.
3. Global coding, validation, safety, and tool-selection rules.
4. Workspace and isolation policy, including how to handle concurrent work and
   existing changes.
5. Subagent mechanics and model or harness selection, with general quota and
   cost guidance appropriate to your accounts.
6. Persistent-memory policy, if you use one: what is worth retaining, what is
   private, and what must never be stored.
7. Interaction and time conventions, such as how questions are asked and when
   dates must be verified.
8. Private infrastructure and runbooks that remain local rather than entering
   a public repository.
9. Known pitfalls and durable lessons that prevent repeated mistakes.

Start small and revise it as real collaboration reveals useful rules. Never copy
someone else's `AGENTS.md` blindly: their trust boundaries, tools, budgets, and
preferences will not match yours. Never put secrets in the file or commit it to
a repository.

Illustrative skeleton:

```md
# Agent profile

## Who I am

<Describe the expertise and context relevant to your work.>

## Working and communication style

<Describe how you want work performed, validated, and reported.>

## Coding and tool rules

<List global engineering, safety, and tool-selection principles.>

## Workspace and isolation

<Define boundaries for repositories, concurrent work, and existing changes.>

## Subagents

<Describe delegation mechanics and general quality, speed, and cost tradeoffs.>

## Persistent memory

<Define what may be retained and what must remain private.>

## Interaction and time

<State question, status-update, and date-verification conventions.>

## Local infrastructure and runbooks

<Keep operational details in local-only guidance and never commit secrets.>

## Known pitfalls

<Record durable lessons that prevent repeated mistakes.>
```

## Install

Use the separate-checkout package installation in [SETUP.md](SETUP.md). It keeps
the repository outside `~/.pi/agent` and lets Pi reference it as a local package,
so existing private agent state is not replaced.

## License

This repository does not declare a license. The acknowledgement in
[CREDITS.md](CREDITS.md) is attribution, not a license grant. Dependencies and
upstream projects remain subject to their own licenses.
