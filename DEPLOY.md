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

From another machine on the LAN, the session launcher is at
`http://192.168.1.149:8880/`.

## Pointing scurrycat.ca at it

`PUBLIC_URL` is the one setting that matters here. It is the base URL encoded
into the QR code the audience scans, so it has to be a hostname their phones
can actually resolve — not the container's address, and not the LAN IP if they
are on cell data.

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
| `PUBLIC_URL` | derived | **Set this in production.** Base URL in the join QR code |
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
