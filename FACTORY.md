# The factory

A three-seat band of coding agents that plans work, implements it, hands off evidence, and has
it independently checked before anything counts as done. It is task-agnostic: the seats' standing
instructions (`mandates/`) name no product, domain or interface. Everything specific to a job
goes in the task the human posts into the room.

## The crew

| Seat | Mandate | Runtime | Model | Owns |
|---|---|---|---|---|
| coordinator | [mandates/coordinator.md](mandates/coordinator.md) | Claude Code | claude-opus-5 | plan, sequencing, decisions log, acceptance bookkeeping, the report |
| implementer | [mandates/implementer.md](mandates/implementer.md) | Claude Code | claude-sonnet-5 | code and its tests, one work item at a time, handoffs with reproducible evidence |
| verifier | [mandates/verifier.md](mandates/verifier.md) | Claude Code | claude-opus-5 | acceptance checks derived from the specification before the build, independent reproduction, adversarial probes, the veto |

A verifier on a different model family from the seats that build does not share their blind
spots, and this factory was developed with that split: the verifier ran on Codex
(`gpt-5.6-terra`, high effort), where it removed a guard from the source unprompted to confirm
the concurrency tests failed without it, then restored it. That is the strongest evidence
available that a suite is load-bearing rather than decorative.

It is off by default anyway, because the cost of the split is asymmetric. A run that cannot be
re-dispatched has no recovery from a provider usage limit: a verifier that stops halfway costs
the whole deliverable, not an evening. Same-family review that finishes beats cross-family
review that runs out. Opt the split back in with `CODEX_ROLES=verifier factory/bin/create-seats
verifier` when the window is fresh and the work is worth it.

Each seat runs in its own git worktree (`seat/<role>` branch), so the verifier always tests the
exact handed-off commit, never the implementer's working copy. Each worktree is configured with
its own git identity, so the history says which seat wrote which change instead of attributing
everything to a single committer.

## Routing

- Seats address only the seat that must act next: coordinator → implementer (assignment),
  implementer → verifier (HANDOFF), verifier → coordinator (ACCEPT) or implementer (REJECT).
- The implementer and verifier never address the human. Only the coordinator escalates, and
  only for irreversible, product-changing or requirement-conflicting choices.
- Deliberate exclusion: the implementer is never told the verifier's probes in advance beyond
  the published acceptance suite, so it cannot build to the probes.

## One typical flow

1. The human posts a task, with its specification, into the room and mentions the coordinator.
2. The coordinator lists every requirement with its reference, publishes the plan and work items,
   and asks the verifier to derive acceptance checks for the milestone.
3. The verifier writes the acceptance suite from the specification alone and publishes a coverage map.
   Meanwhile the implementer builds item 1 and posts a HANDOFF with commit and evidence.
4. The verifier checks out that commit cleanly, reproduces, reviews the diff, probes
   (concurrency, replay, malformed input, boundaries, time, restart, error paths) and posts a VERDICT.
5. REJECT goes back to the implementer with reproducible findings. ACCEPT goes to the
   coordinator, which marks the item done and assigns the next one.
6. At a milestone, the verifier runs the full regression gate on the snapshot. The coordinator
   freezes it and reports to the human, who decides whether to accept.

## The delete test

Without the room, the verifier's REJECT has nowhere to land and no authority. The implementer's
"done" becomes the only signal, which is exactly the self-certification this factory exists to prevent.

## Stand it up yourself

Prerequisites: Jam Desktop (signed in, `jam preflight` green), Claude Code, git.

```sh
CLAUDE_CONFIG_DIR=~/.claude-factory claude   # one time: sign in, then exit
CLAUDE_CONFIG_DIR=~/.claude-factory claude plugin list      # disable anything listed:
CLAUDE_CONFIG_DIR=~/.claude-factory claude plugin disable <name>
factory/bin/create-seats                      # one Jam-owned agent per mandate
```

Each seat runs through `bin/claude-seat`. It points Claude Code at a dedicated config directory
and switches off connectors attached to the Claude login. Seats therefore inherit none of the
operator's personal instructions, skills, plugins or tool servers, only their mandate: Claude
Code's core tools plus the room connection. The mandate is linked live as the agent's owner instructions, so editing
the file changes the seat.

Before a deliverable is called done, run `factory/bin/offline-check <dir>`: it builds the
directory's Dockerfile and runs its gate with networking off, so anything that quietly reaches
the internet fails here instead of on the grader's machine. Pull the base image once while online.

Run `factory/bin/watchdog` alongside a long job. A seat can end a turn on a runtime error after
staging its reply, leaving the message queued and the job silently stopped; the watchdog spots a
seat that has queued work but no activity and restarts it, which redelivers the message.

Then, in Jam Desktop, open a room, add the three seats, and post your task and its
specification, mentioning the coordinator.
Before changing any mandate, run `factory/lint/lint_mandates.py factory/mandates/*.md --spec <your spec files>`.
