# Deploying

Only one half of this project deploys. **The relay** is a container that carries votes
between phones and whoever is running the show; **the client** — the board, the asset
pipeline and the projector — runs from a git checkout on the presenter's own machine and is
never exposed to anything. If you are looking for how to run a show, that is in
[README.md](README.md). This is how the phones reach it.

The relay listens on **8880**. That port is deliberate: rare enough to avoid colliding with
something already running, and still on Cloudflare's proxyable HTTP port list so a plain
port-forward works as an alternative to a tunnel.

## What is in the image, and what is deliberately not

The relay holds a room code, at most one open poll, the ballots cast into it, and the keys
that say who may open a room. It has no scenario, no engine, no `yaml` and no `qrcode`. It
could not read a story if you handed it one, and there is no message it can send toward a
client that is a command.

That is the security story in one line: **a key stolen off this box buys the ability to open
a room and publish a poll to some phones, and nothing else.** It does not buy the show. The
absence is enforced rather than remembered — `tests/relay.test.ts` walks the import graph
from `server/index.ts`, asserts the whole of what it borrows is one protocol file, and reads
the `Dockerfile`, `.dockerignore` and `docker-compose.yml` to check no scenario reaches the
container by any of the three routes.

## On the Docker host (192.168.1.149)

Clone and start:

```bash
git clone https://github.com/TerraIncognito-sudo/Interactive_Scenarios.git
```

```bash
cd Interactive_Scenarios && docker compose up -d --build
```

**Run that in a terminal on the host itself.** Docker Desktop's `credsStore: desktop` needs
an interactive Windows logon session, so a build over SSH fails with "A specified logon
session does not exist" — even for an anonymous pull of a public base image. `DOCKER_CONFIG`
and `--config` do not get around it.

Confirm it came up:

```bash
curl -s http://localhost:8880/api/health
```

```json
{ "ok": true, "rooms": 0, "keyed": false, "uptime": 3 }
```

`keyed: false` is the interesting field. It is the one thing that explains a relay which is
up and refusing everything — see the next section.

## First run: issue a key

A fresh relay opens **no rooms at all** until somebody signs in and generates a key. That is
on purpose, and it is the same rule as an empty `PUBLIC_URL` never quietly meaning the
permissive thing: an absent value must never mean the permissive one.

1. Find the console password. If you did not set `ADMIN_PASSWORD`, one was generated and
   printed at startup:

   ```bash
   docker compose logs interactive-scenario | grep -A3 "ADMIN PASSWORD"
   ```

2. Open `http://192.168.1.149:8880/keys` and sign in.

3. **Generate** a key with a label saying which machine it is for — "Nick's laptop", "the
   loaner ThinkPad". The label is required, because a list of five-word phrases with nothing
   beside them is a list nobody dares revoke from.

4. In the client, press **Go live** and paste the relay's address and the phrase. It is
   stored in the machine's own config (`~/.interactive-scenario/editor.json`) beside the
   workspace and the models root, never in `project.yaml` — which travels to other machines
   and is opened a year later.

That is the whole of it. Every later show just links.

## Keys, and what revoking does

`/keys` lists every key with its label, when it was made, when it was last used to open a
room, and how many rooms it has open right now. That last column is what makes revoking safe
to do rather than merely possible.

**Revoking refuses the next room and never the running one.** A room already open keeps
running and its phones never notice, which is why a client that drops mid-show can resume
with its room token even if its key was withdrawn while it was gone — the alternative is
forty phones holding a dead code and no way to finish. The deliberate way to stop a running
show is **End** on `/status`, which is a decision somebody makes while looking at the room.

A revoked key stays listed and greyed, with the date. One that vanished would be one somebody
re-issues by accident.

Phrases are five words from a 256-word list — forty bits, typeable once by hand and readable
down a phone line — and failed attempts are rate-limited per address, which is the other half
of forty bits. They are stored in the clear on purpose, because the console has to list them:
a key you can only see once is a key that gets written on a sticky note.

There is deliberately **no `RELAY_KEY` environment variable**, and nobody should helpfully add
one. A secret in a compose file is one phrase shared by everyone who has ever been told it: it
cannot be withdrawn from one person, there is no way to see who is using it, and changing it
locks out every client at once.

## Pages

| Path | Who | Notes |
|---|---|---|
| `/` | the audience | Join screen — enter a room code |
| `/join/CODE` | the audience | What the QR points at |
| `/status` | you | Live rooms, who opened them, and End |
| `/keys` | you | Issue and revoke |
| `/api/health` | monitoring | `rooms`, `keyed`, `uptime` |

`/admin` redirects to `/status`, so older links still work.

`/status` shows each room's code, how many phones are connected, whether a poll is open and
until when, which key opened it, its age and its last activity. It exists because the failure
it is for is real: a room of forty people say "it says no such room" and you are holding a
phone. Without it the answer is `docker logs` over SSH from a venue.

**It does not carry the room token, and must not.** The list it replaced did, and stranded a
live show is what that was for; the client holds its own token now, so the field is gone and
with it this page's ability to hand a reader full control of every running show.

## The console password

`/status`, `/keys` and every endpoint behind them require `ADMIN_PASSWORD`. It does **not**
gate joining or voting — the audience needs nothing but a room code, which is the whole
design.

Leave it unset and a readable one is generated at every startup and printed to the log. That
is safe but changes on each restart, so set your own for anything you run more than once:

```bash
cp .env.sample .env
```

Edit `ADMIN_PASSWORD` in it and restart:

```bash
docker compose up -d
```

`.env` is gitignored, and compose reads it automatically. The sign-in cookie is signed with a
secret stored in the database, so it survives restarts and you are not asked to log in again
after every redeploy.

## Pointing a hostname at it

**You usually do not need `PUBLIC_URL`.** Join links are derived from the address each
request arrives on: browse to `http://192.168.1.149:8880` and phones get LAN links; reach it
through Cloudflare and they get public ones, because the proxy forwards `X-Forwarded-Host`
and `X-Forwarded-Proto` and the relay honours both.

Set `PUBLIC_URL` only when the address the audience uses differs from the one the relay can
see — a proxy that rewrites Host, for instance.

### Cloudflare Tunnel (recommended)

No inbound firewall holes, no exposed IP, and TLS is handled for you.

```bash
cloudflared tunnel --url http://192.168.1.149:8880
```

For a permanent named tunnel, route the hostname to `http://192.168.1.149:8880` in the
Cloudflare Zero Trust dashboard, then set:

```bash
PUBLIC_URL=https://scurrycat.ca docker compose up -d
```

### Port forwarding instead

Forward external **8880** to `192.168.1.149:8880`, point the DNS record at your WAN address,
and set the same `PUBLIC_URL`. Keep the Cloudflare proxy on 8880 specifically — most
arbitrary ports are not proxied.

WebSockets pass through Cloudflare on all plans, which this depends on entirely.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8880` | |
| `HOST` | `0.0.0.0` | |
| `PUBLIC_URL` | derived from the request | Only when the audience's address differs from the one the relay sees |
| `ADMIN_PASSWORD` | generated | Gates `/status` and `/keys`; printed at startup when unset |
| `DATA_DIR` | `/data` | SQLite. Mount a volume — see below |
| `ROOM_TTL_MINUTES` | `240` | Idle rooms are swept after this |
| `LOG_LEVEL` | `info` | |

There is no `SCENARIOS_DIR`. There is nothing in the container to point it at.

### The volume matters more than it used to

`scenario-data:/data` holds two things that cannot be regenerated. It holds **every key ever
issued**, so a wiped volume locks out every client until new ones are generated and pasted in
again. And while a client is disconnected mid-poll it holds **the only copy of the votes** —
the phones are the part you cannot ask to do it again.

A room outlives the client that opened it on purpose: that is what lets a laptop crash
mid-show and come back to the same code. `ROOM_TTL_MINUTES` and the End button are the only
things that ever tidy one up.

## Offline fallback

If the venue's connection is dead, the relay is a container and its join links follow the
request — so bring it up on the presenting laptop:

```bash
docker compose up -d
```

Point the client's relay URL at `http://<laptop-lan-ip>:8880`, and phones on the venue wifi
get LAN join links with nothing configured. You will need to issue a key on that instance
too; it has its own database.

This costs nothing to keep working because the join link is derived rather than fixed, which
is the same property that makes the Cloudflare case need no configuration.

## Updating

Scenarios are no longer mounted and there is no `/api/reload` — the relay has nothing to
reload them into. Updating a **show** means opening the client and editing it; nothing needs
to be deployed. Updating the **relay** means pulling and rebuilding, in a terminal on the
host:

```bash
git pull && docker compose up -d --build
```

Rooms survive that, because they are in the volume rather than in memory. Phones reconnect
through their own backoff and get their own recorded vote highlighted again.

## Before an event

1. `npm run validate` — no errors. Add `--strict` and every declared asset must exist too.
2. The command centre tab is empty. That is the whole promise it makes.
3. Press Play, open the stage window, **click it once**, and let it report ready before
   starting. The board disables Start until it has, and says why.
4. Run one poll with **zero** cast votes and confirm the story continues to the scenario's
   declared default. It is the path hardest to rehearse and worst to discover live.
5. `curl -s .../api/health` on the relay and check `keyed` is `true`.
6. Go live, then join from a phone **on cell data with wifi off** and confirm the QR
   resolves and a vote reaches the board.
7. Reload the stage window mid-show and confirm it resyncs to the current beat.
