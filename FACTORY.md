# The factory

A three-seat band of coding agents that plans work, implements it, hands off evidence, and has
it independently checked before anything counts as done. It is task-agnostic: the seats' standing
instructions (`mandates/`) name no product, domain or interface. Everything specific to a job
goes in the task the human posts into the room.

## The crew

| Seat | Mandate | Runtime | Model | Owns |
|---|---|---|---|---|
| coordinator | [mandates/coordinator.md](mandates/coordinator.md) | OpenCode | moonshotai/Kimi-K2.5 | plan, sequencing, decisions log, acceptance bookkeeping, the report |
| implementer | [mandates/implementer.md](mandates/implementer.md) | OpenCode | MiniMaxAI/MiniMax-M2.5 | code and its tests, one work item at a time, handoffs with reproducible evidence |
| verifier | [mandates/verifier.md](mandates/verifier.md) | OpenCode | zai-org/GLM-5.3 | acceptance checks derived from the specification before the build, independent reproduction, adversarial probes, the veto |

Three model families, one per seat, so no two seats share a blind spot. That is the point of
the split: a check that thinks like the thing it is checking is not a check. `seats.conf` is
the single source of truth for these rows, and a test fails if any mandate disagrees with it
or if every seat ends up on one model.

**They were chosen on evidence, not reputation.** Each candidate was handed a function with an
off-by-one against a stated rule and asked for a verdict. All three found it; the verifier's
model was the one that cited the file and line, named the exact input that breaks it, and gave
the one-character fix. A model that merely agrees something is wrong is not useful in that seat.

The earlier build ran all three seats on one vendor, with the verifier optionally on a second.
That was abandoned for a plainer reason than quality: a subscription runtime hits a rolling
usage window you cannot see coming, and a run that cannot be re-dispatched loses the whole
deliverable when it does.

Per-request inference does not remove that risk, it changes its shape. There is still a
ceiling, and more than one: what is left to spend, and how many seats may call at once. The
difference is that what is left to spend is a figure you can read before you dispatch and
divide by the cost of a rehearsal. That is the whole argument: not that the run cannot stall,
but that you can find out beforehand whether it will. Measure a rehearsal
with `opencode stats`, multiply by the shape of the real run, and compare. If it does not fit,
that is a decision to take before the dispatch, not a discovery halfway through.

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

Prerequisites: Band Desktop (signed in, `preflight` green), git, Docker, and the runtimes named
in `seats.conf`. For the OpenCode seats: `brew install sst/tap/opencode` and a provider config at
`~/.config/opencode/opencode.json`. Keep the API key in the environment, never in either
repository — a deliverable is public and its history cannot be unpublished.

```sh
. ~/.config/featherless/env                   # or wherever the key lives
factory/bin/create-seats                      # worktree, git identity and mandate per seat
```

`create-seats` reads `seats.conf`. Where Band has an owned-runtime transport it creates the
agent; where it does not, it prepares the worktree and identity and hands over to `run-seat`,
which starts the process on this machine and attaches it.

**All three seats are Band-owned, over ACP.** That was worth finding. The documented route for
an open-weights seat is a server plus an adapter process you run and supervise yourself, with
tool calls auto-accepted because nothing is there to approve them. Band speaks ACP and the
runtime serves it, so the seat is supervised like any other: the mandate is live-linked as its
owner instructions, the watchdog can restart it, and no seat needs blanket permission to run
shell commands. It was confirmed with `create --dry-run`, which probes the runtime, the
protocol and the credential without creating anything.

The one cost: ACP accepts no model selector, and it rejects one before the runtime is even
spawned. So the model comes from configuration, which means a config directory per role rather
than one shared file. `opencode-seat` generates each from `seats.conf` at start, so a seat's
model still has exactly one source and cannot drift from its mandate.

**Every runtime starts through a wrapper that gives the seat its own configuration**, so seats
inherit none of the operator's personal instructions, skills, plugins or tool servers — only
their mandate. `claude-seat` sets a dedicated config directory and switches off the connectors
attached to that sign-in. `opencode-seat` gives the seat a HOME of its own.

That last one was not optional. OpenCode loads the operator's `~/.claude/CLAUDE.md` into every
session, and it was caught by asking a seat to list the instruction documents it had been given:
it quoted a personal working agreement back. A seat carrying that is not running on its mandate,
and in a judged run the agreement is visible in the room and competes for the seat's attention.
The config's `instructions` key only adds files, so a separate HOME is the only reliable
suppression. Re-run that probe after changing any wrapper: ask a seat what instructions it has,
and the only correct answer names its mandate and nothing else.

Before a deliverable is called done, run `factory/bin/offline-check <dir>`: it builds the
directory's Dockerfile and runs its gate with networking off, so anything that quietly reaches
the internet fails here instead of on the grader's machine. Pull the base image once while online.

Run `factory/bin/watchdog` alongside a long job. A seat can end a turn on a runtime error after
staging its reply, leaving the message queued and the job silently stopped; the watchdog spots a
seat that has queued work but no activity and restarts it, which redelivers the message. It gives
up after `--max-restarts` and prints an ALERT, because a restart cannot fix a provider usage limit.

This matters most where no one is watching. A run that cannot be restarted from the outside has
the watchdog as its only recovery, so it is part of the factory rather than an operator's
convenience.

**Pass it the same prefix as the seats:** `SEAT_PREFIX=x create-seats` pairs with
`watchdog --prefix x`. Mismatch them and every inbox reads empty, every seat is reported healthy,
and a real stall runs to the end of the job unnoticed. A test covers this specifically.

Then, in Jam Desktop, open a room, add the three seats, and post your task and its
specification, mentioning the coordinator.
Before changing any mandate, run `factory/lint/lint_mandates.py factory/mandates/*.md --spec <your spec files>`.

**Changing what a seat runs is two steps:** edit its row in `seats.conf`, then
`factory/bin/sync-mandate-headers` to rewrite the mandate headers from it (`--check` reports
drift and exits non-zero). That is also the way back: rewrite the three rows to a runtime you
have already proven, run the sync, and the seats change with them. It was tested in that
direction, not assumed.

The seats read these mandates live, and a deliverable carries copies of them at its root, so
the two drift apart the moment one is edited — and the copy is the one a reader judges.
`factory/bin/assemble-result <repo>` syncs them, along with this file and the tooling it
mentions; `--check` reports drift without copying and exits non-zero, which is the thing to run
before a final push. The tooling ships because this file describes it: a reader told to run
`factory/bin/watchdog` should find it.
