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

`seats.conf` is the single source of truth for these rows: it names each seat's runtime, model
and display name, `create-seats` launches from it, the mandates are tested against it, and the
mandates ship under the display names because that is what a reader matches them by.

**A roster of three different model families was measured first, and retired on arithmetic.**
One seat per family, chosen by handing each candidate a function with an off-by-one against a
stated rule and keeping the one that cited the line and named the breaking input. It built all
four stages of the practice track and passed every shipped check. It also cost $24.53 to do
that on a shared counter, which is a problem small enough to read in a minute. The graded work
is a different order of work, so the credit would not have reached the end of it. A run that
cannot afford to finish scores nothing, so the band went back to the runtime that is paid for.

Two seats now share a family, and that is a genuine loss: the verifier no longer checks from
outside the blind spots of the seat that built the work. It is taken deliberately, with the
measurement written down rather than the preference. The rehearsal is worth reading for what it
caught rather than what it cost — see the write-up kept beside this factory.

Each seat runs in its own git worktree (`seat/<role>` branch), so the verifier always tests the
exact handed-off commit, never the implementer's working copy. Each worktree is configured with
its own git identity, so the history says which seat wrote which change instead of attributing
everything to a single committer.

## What the seats are allowed to do, and why it is not tighter

A seat runs shell commands without being asked. That is deliberate, and it is not a setting
anyone forgot to tighten.

The runtime offers three postures: ask before each action, allow all, or deny all. `ask` stalls
until a human answers, and in a run whose whole premise is that nobody answers, a stall is the
end of the run. `deny` leaves a seat that cannot build or test anything. That leaves one.

The finer-grained posture some runtimes offer — approve file edits, prompt for commands — does
not help either, and it is worth saying why, because it sounds like the obvious middle ground.
A seat's evidence *is* commands: it builds, runs the suite, pastes the real output. Prompting on
commands prompts on every handoff, which is the same stall by a slower route.

Container isolation is not available for this runtime at all; it is refused outright. So the
blast radius is managed by where a seat runs, not by what it is permitted to do: each works in
its own checkout, commits only there, and nothing it does is outside version control. Run the
band on a machine where that is an acceptable worst case. This was measured, not assumed — each
posture was probed against the runtime before the seats were created.

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
