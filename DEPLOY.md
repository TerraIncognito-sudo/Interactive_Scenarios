# Deploying

The server listens on **8880**. That port is deliberate: rare enough to avoid
colliding with something already running, and still on Cloudflare's proxyable
HTTP port list so a plain port-forward works as an alternative to a tunnel.

## On the Docker host (192.168.1.149)

Clone and start:

```bash
git clone https://github.com/TerraIncognito-sudo/Interactive_Scenarios.git
```

```bash
cd Interactive_Scenarios && docker compose up -d --build
```

Confirm it came up:

```bash
curl -s http://localhost:8880/api/health
```

From another machine on the LAN, the admin console is at
`http://192.168.1.149:8880/admin`.

## Pages

| Path | Who | Notes |
|---|---|---|
| `/` | the audience | Join screen — enter a room code |
| `/admin` | you | Run sessions; asks for the host password |
| `/display/?room=…&token=…` | the projector | Handed out by `/admin` |
| `/host/?room=…&token=…` | you | Handed out by `/admin` |

`/new` redirects to `/admin`, so older links still work.

## The host password

`/admin` and the session endpoints require `ADMIN_PASSWORD`, so a stranger who
finds the server cannot spawn or interfere with sessions. If you do not set one,
a readable password is generated at startup and printed in the log:

```bash
docker compose logs interactive-scenario | grep -A3 "ADMIN PASSWORD"
```

Set your own by copying the sample and editing it — compose reads `.env`
automatically, and it is gitignored so the password stays out of the repo:

```bash
cp .env.sample .env
```

Then edit `ADMIN_PASSWORD` and restart:

```bash
docker compose up -d
```

The sign-in cookie is signed with a secret stored in the database, so it
survives restarts and you are not asked to log in again after every redeploy.

## Pointing scurrycat.ca at it

**You usually do not need `PUBLIC_URL`.** Links are derived from the address
each request arrives on: browse to `http://192.168.1.149:8880` and you get LAN
links back; reach it through Cloudflare and you get `scurrycat.ca` links,
because the proxy forwards `X-Forwarded-Host` and `X-Forwarded-Proto`.

Set `PUBLIC_URL` only when the address the audience uses differs from the one
the server can see — a proxy that rewrites Host, for instance.

### Cloudflare Tunnel (recommended)

No inbound firewall holes, no exposed IP, and TLS is handled for you.

```bash
cloudflared tunnel --url http://192.168.1.149:8880
```

For a permanent named tunnel, route `scurrycat.ca` to
`http://192.168.1.149:8880` in the Cloudflare Zero Trust dashboard, then set:

```bash
PUBLIC_URL=https://scurrycat.ca docker compose up -d
```

### Port forwarding instead

Forward external **8880** to `192.168.1.149:8880`, point the DNS record at your
WAN address, and set the same `PUBLIC_URL`. Keep the Cloudflare proxy on 8880
specifically — most arbitrary ports are not proxied.

WebSockets pass through Cloudflare on all plans, which this depends on entirely.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8880` | |
| `PUBLIC_URL` | derived from the request | Only needed when the audience's address differs from the one the server sees |
| `ADMIN_PASSWORD` | generated | Gates `/admin`; printed at startup when unset |
| `DATA_DIR` | `/data` | SQLite; mount a volume so a restart does not end a live show |
| `SCENARIOS_DIR` | `./scenarios` | Mounted read-only by compose |
| `ROOM_TTL_MINUTES` | `240` | Idle rooms are swept after this |
| `LOG_LEVEL` | `info` | |

## Updating scenarios without a redeploy

`scenarios/` is mounted into the container, so scenarios are content rather than
code. Edit a file on the host, then:

```bash
curl -X POST http://localhost:8880/api/reload
```

Validate before you rely on it — this is the check that turns "the show froze in
front of forty people" into an error message at your desk:

```bash
npm run validate
```

## Offline fallback

If the venue's connection is dead, the same server runs on the presenting
laptop and the audience joins over the room's wifi:

```bash
npm run local
```

It prints a QR code in the terminal, picks the LAN address phones are most
likely to reach, and lists the alternatives if it guessed wrong. Override with
`PUBLIC_URL=http://<address>:8880 npm run local`.

## Before an event

1. `npm run validate` — no errors.
2. Open the display link on the projector and let it report **ready** before
   starting. The host console shows this and warns if you start early.
3. Join from a phone **on cell data with wifi off** and confirm the QR resolves.
4. Run one poll with deliberately zero votes and confirm the story continues to
   the scenario's declared default.
5. Reload the display mid-show and confirm it resyncs to the current beat.
