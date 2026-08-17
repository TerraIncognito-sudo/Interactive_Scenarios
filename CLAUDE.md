# CLAUDE.md

Guidance for Claude Code working in this repo. Read [README.md](README.md) for what the
project is and [DEPLOY.md](DEPLOY.md) for how it ships. This file covers what those two
don't: the constraints that will bite you, and the invariants that must not be broken.

## Commands

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run validate
```

```bash
npm run build
```

`npm start` runs the server, `npm run local` runs it in laptop-fallback mode, `npm run dev`
watches, `npm run editor` starts the scenario editor on 8890. **Never leave a dev server
running** — one was left on port 8880 once and served a stale page to the user's browser
while they debugged a "crash" on the real server. Kill what you start.

## The build constraint that shapes everything

Server code is TypeScript that **Node 24 runs directly** by stripping types. There is no
server build step, and keeping it that way is deliberate. Three consequences:

- **Relative imports carry an explicit `.ts` extension.** `import { Room } from './room.ts'`.
- **No non-erasable syntax.** No `enum`, no `namespace`, and no parameter properties —
  `constructor(private readonly store: Store)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
  at runtime. Declare the field, assign it in the body. `erasableSyntaxOnly` catches this
  in typecheck; trust it, it is not being fussy.
- **`typescript` is 7.x**, the native compiler. It does not auto-include `@types`, hence the
  explicit `"types": ["node"]` in tsconfig.

Only the client is bundled (Vite, four entry points, no root `index.html` — the server
routes `/` to the player app so the landing page is the audience join screen).

`node --test tests/` does not work. The script uses a quoted glob: `node --test "tests/**/*.test.ts"`.

## Invariants

These are load-bearing. Each one exists because breaking it produced a real failure.

**The engine is pure.** `src/engine/engine.ts` is `state + event -> state` with no I/O. That
is what makes every branch path testable without a browser, and what lets the display run
the same engine client-side. Do not reach for a timer, a socket, or the database in there.

**Players never receive a snapshot.** `Room.subscribe()` sends players only `playerState`.
A snapshot contains upcoming dialogue, the scene, and any pending poll result — sending it
leaks the story to forty phones. A test guards this.

**`close()` ends a show; `shutdown()` stops the process.** They are not synonyms. Marking
rooms closed on shutdown means a container restart or a SIGTERM silently destroys every
live session.

**Every poll needs a `default:`.** Enforced by the validator. A poll that receives zero
votes must never deadlock in front of an audience.

**Scenario files are content and content must never execute code.** The expression language
in `src/engine/expr.ts` is a hand-written recursive-descent parser with no `eval`, no
property access, and no function calls. Keep it that way.

**Scenario schemas use `z.strictObject`.** A typo like `nxt:` should be a loud load-time
error, not a silently ignored key.

**Generated links follow the request.** `baseUrlFor()` honours `X-Forwarded-Host`/`Proto`,
so a LAN request gets LAN links and a Cloudflare-proxied one gets public links with no
config. `PUBLIC_URL` is an override for the rare mismatch, and an empty value means unset —
it must never fall back to `localhost`, which is how links once pointed at the operator's
own machine while looking perfectly valid.

**Room timer callbacks are wrapped in `Room.guard()`.** An exception inside `setTimeout` is
uncaught, and an uncaught exception exits Node — one malformed node would kill every other
room on the server. Anything scheduled goes through the guard.

**Room codes exclude `O/0`, `I/1`, `S/5`, `Z`.** They are read off a projector from the back
of a room.

## Layout

| Path | What lives there |
|---|---|
| `src/engine/` | Pure state machine, vote resolution, expression parser |
| `src/scenario/` | Zod schema, YAML loader, graph checker, `validate` CLI |
| `src/server/` | Fastify, rooms, WebSocket, SQLite, admin auth |
| `src/client/` | `display/` projector, `host/` console, `player/` phone, `admin/` console |
| `tools/editor/` | The scenario editor — a separate local process, not part of the server |
| `src/shared/protocol.ts` | Message unions, Zod-validated in both directions |
| `scenarios/` | Content. Adding a scenario is adding a folder — no code changes |

`src/scenario/check.ts` holds the graph integrity Zod cannot express: dangling `next`,
unreachable nodes, unknown characters and scenes, poll defaults that are not options,
unknown `$placeholder`s. Run `npm run validate` after touching a scenario.

The editor is a separate process by design — authoring happens at a desk, the game server
runs in front of an audience, and only the editor writes to `scenarios/`. Its simulator
calls the production `reduce`, so **never give it its own copy of the engine**: a
simulation that could drift from the real thing is worse than none. `parseScenarioSource`
in `src/scenario/load.ts` is the shared validation path — the editor and the server must
never disagree about what a valid scenario is.

## Conventions

Comments explain **why**, not what — several in this codebase record the failure that
motivated the code, and that is the house style. Match it rather than stripping it.

Tests are `node:test` + `node:assert/strict`, colocated in `tests/`, named for the behaviour
rather than the function. The server tests drive real sockets against a real server on an
ephemeral port; prefer extending those over mocking.

## Deployment notes

The Docker host is `192.168.1.149`, reachable over SSH, running Docker Desktop on Windows.
**Rebuilding remotely does not work**: Docker Desktop's `credsStore: desktop` requires an
interactive Windows logon session, so `docker compose up -d --build` over SSH fails with
"A specified logon session does not exist" — even for an anonymous pull of a public base
image. `DOCKER_CONFIG` and `--config` do not get around it. The rebuild has to be run by
the user in their own terminal on that machine.

`.env` is gitignored and the user maintains it on the server; `docker-compose.yml` reads it
via `${VAR:-}` defaults. Do not edit the server's compose file to hardcode values.
