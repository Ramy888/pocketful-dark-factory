# Pocketful, built by a dark factory

**Track:** `pocketful` — a wallet and payments service, where the hard part is that money is
never created, destroyed or spent twice under concurrent transfers, retries and rounding.

**Team:** solo entrant. One person, three agent seats. The person dispatched each stage and read
the report; the seats did the work.

## How to read this repository

| Path | What it is |
|---|---|
| `FACTORY.md` | The factory: the seats, why they are split that way, what it cost, how it catches bad work. Start here. |
| `mandates/` | One file per seat, named after the seat as the room shows it. Each opens with the harness and model that seat runs. These are the factory's instructions and say nothing about payments. |
| `room.json` | The room, downloaded whole from Band. Every message the seats exchanged, including their tool calls. This is the record of who did the work. |
| `stage-1/` … | One complete, buildable service per stage. Each is the previous stage carried forward and widened to the next specification, and each holds the solution to its own stage only. |

Every stage folder has a `Dockerfile` and a `RUN.md`. Build the folder and talk to it over HTTP;
nothing on the host is needed beyond Docker.

## What the factory is

Three seats that plan, build and independently check, with no human in the loop between the
dispatch and the report:

- a **coordinator** that reads the specification, plans work items against it, and routes them
- an **implementer** that builds one item at a time and hands off evidence a third party can reproduce
- a **verifier** that derives its acceptance checks from the specification before seeing any code,
  reproduces every handoff from a clean state, and holds a veto no other seat can override

The mandates are deliberately free of anything about payments. Point them at a different problem
and they still describe a working factory — that is the test they are written to pass.
