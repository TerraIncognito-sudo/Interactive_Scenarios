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

Structural problems are errors; art that has not been made yet is a warning, so a scenario
can declare its media before the media exists — which is what puts it on the editor's asset
board. Add `--strict` for a pre-show check, where a missing file *is* an error.

```bash
npm run build
```

`npm start` runs the server, `npm run local` runs it in laptop-fallback mode, `npm run dev`
watches, `npm run editor` starts the scenario editor on 8890. **Never leave a dev server
running** — one was left on port 8880 once and served a stale page to the user's browser
while they debugged a "crash" on the real server. Kill what you start.

```bash
npm run project:new -- <storyboard.md> <target-folder> "Some Title"
```

Scaffolds a project folder from a storyboard, for when a storyboard exists and there is no
scenario yet. Once a folder has a `scenario.yaml` the editor takes over: it asks for a
**workspace** folder on first run and lists every folder inside it that has one. See
[docs/asset-pipeline.md](docs/asset-pipeline.md).

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

**An asset's production section comes from the schema field that referenced it**, never from
its extension. A `.mp3` in `voice:` and a `.mp3` in `music:` are different work made by
different models. `assetReferencesOf` is the single walk both `assetsOf` and the editor's
board are built from — two walks would eventually disagree, and the editor's would be the one
that disagreed silently.

**The editor and the player must agree on filenames.** The player opens exactly the names in
`scenario.yaml`, so the editor may never invent one. Seeding prompts from a storyboard keys
every row to `assetReferencesOf(scenario)` and reports anything it cannot place; a prompt
written against a name of the editor's own choosing would belong to a file nothing ever loads.
The one place names *are* invented is `scaffold.ts`, which is writing the scenario that will
reference them — so the two files still agree. Tests guard both routes.

The same rule governs what a voice clip *says*: `text` on a voice row is the scenario's line,
never the storyboard's blockquote. A storyboard quotes a whole delivery at once where the
scenario splits it into the lines the display shows, so reading the storyboard by position puts
one line's words in another line's clip. The storyboard contributes the *Delivery:* note and
nothing else — matched by speaker, since one note covers every line split out of its block.

**Anything the pipeline needs done to a project, the editor does.** If a scenario has to be
hand-edited or a script run once to get an asset onto the board, the ecosystem has a hole in it
and the two halves will drift. Declaring `voice:` on every line is `wireVoice` in
`tools/editor/wire.ts`; removing a recipe the scenario stopped referencing is `pruneOrphans`.
Both are buttons, both are idempotent, and both edit by source offset rather than by
re-serialising, so the author's comments and hand-wrapped folded scalars survive.

**The machine never rewrites `project.yaml` wholesale.** It is the author's file, full of
hand-tuned prompts and comments recording why. Field edits go through YAML's document API
(`tools/editor/projects.ts`); parsing to an object and re-serialising strips every comment in
the file the first time anyone touches a text box. A test guards this.

## Layout

| Path | What lives there |
|---|---|
| `src/engine/` | Pure state machine, vote resolution, expression parser |
| `src/scenario/` | Zod schema, YAML loader, graph checker, `validate` CLI |
| `src/server/` | Fastify, rooms, WebSocket, SQLite, admin auth |
| `src/client/` | `display/` projector, `host/` console, `player/` phone, `admin/` console |
| `tools/editor/` | The scenario editor — a separate local process, not part of the server |
| `tools/editor/workspace.ts` | Which folder holds the projects, and the server-side folder picker |
| `tools/editor/project.ts` | Asset projects: `project.yaml` (author-owned) + `.ledger.json` (machine-owned) |
| `tools/editor/sections.ts` | The status board — scenario, recipes, ledger and disk reconciled |
| `src/shared/protocol.ts` | Message unions, Zod-validated in both directions |
| `scenarios/` | Content. Adding a scenario is adding a folder — no code changes |

`src/scenario/check.ts` holds the graph integrity Zod cannot express: dangling `next`,
unreachable nodes, unknown characters and scenes, poll defaults that are not options,
unknown `$placeholder`s. Run `npm run validate` after touching a scenario.

The editor is a separate process by design — authoring happens at a desk over weeks, the
game server runs in front of an audience. **The editor cannot reach `scenarios/` at all**:
it serves no route into that folder and writes only inside the author's chosen workspace.
Deploying is a person copying a finished project folder across when the show is ready, and
a test asserts the capability stays absent. An editor able to write into the folder a live
show is served from will eventually do it by accident. Its simulator
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
