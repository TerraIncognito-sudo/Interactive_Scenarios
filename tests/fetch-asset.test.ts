/**
 * The projector's prefetch, against a server that misbehaves on purpose.
 *
 * Every case here is a way the old media-element prefetch lost an asset on a
 * remote link while never losing one on a laptop. Measured against a real show
 * over a real tunnel, the old path dropped 53 of 64 assets on a cold cache and
 * this one dropped none — so these are the specific promises that keep it there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { fetchAsset } from '../src/client/shared/fetch-asset.ts';

/** A server whose behaviour each test writes for itself. */
async function serving(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => handler(req.url ?? '/', res));
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    server,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

test('a body that arrives is reported with every byte of it', async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const s = await serving((_url, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end(payload);
  });
  try {
    let bytes = 0;
    const result = await fetchAsset(`${s.base}/clip.mp4`, (n) => {
      bytes += n;
    });
    assert.equal(result.ok, true);
    // The whole file, not the fraction a media element decides it could play
    // through — which on the real show was about 6% of a 29 MB clip.
    assert.equal(bytes, payload.length);
    if (result.ok) assert.equal(result.bytes, payload.length);
  } finally {
    await s.close();
  }
});

test('a transient 502 is retried, and the asset still arrives', async () => {
  let hits = 0;
  const s = await serving((_url, res) => {
    hits += 1;
    // Two failures then success: the shape of a proxy under load, which is what
    // a remote venue actually produces. With no retry this was a permanent hole.
    if (hits <= 2) {
      res.writeHead(502);
      res.end('bad gateway');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  try {
    const result = await fetchAsset(`${s.base}/a.png`, () => {}, { backoffMs: 1 });
    assert.equal(result.ok, true);
    assert.equal(hits, 3);
  } finally {
    await s.close();
  }
});

test('a 404 is not retried — it will not be there in four hundred milliseconds', async () => {
  let hits = 0;
  const s = await serving((_url, res) => {
    hits += 1;
    res.writeHead(404);
    res.end('nope');
  });
  try {
    const result = await fetchAsset(`${s.base}/gone.png`, () => {}, { backoffMs: 1 });
    assert.equal(result.ok, false);
    // Once. Spending three attempts to prove a rename costs a presenter time in
    // front of a room to learn what the first attempt already said.
    assert.equal(hits, 1);
    if (!result.ok) assert.match(result.why, /404/);
  } finally {
    await s.close();
  }
});

test('bytes from a failed attempt are not counted twice', async () => {
  let hits = 0;
  const s = await serving((_url, res) => {
    hits += 1;
    if (hits === 1) {
      // Half a body, then the connection dies — the retry must not leave those
      // bytes on the total, or a bad link runs the progress past 100%.
      res.writeHead(200, { 'content-length': '2048' });
      res.write(Buffer.alloc(1024, 1));
      res.destroy();
      return;
    }
    res.writeHead(200);
    res.end(Buffer.alloc(2048, 1));
  });
  try {
    let bytes = 0;
    const result = await fetchAsset(`${s.base}/b.mp3`, (n) => {
      bytes += n;
    }, { backoffMs: 1 });
    assert.equal(result.ok, true);
    assert.equal(bytes, 2048);
  } finally {
    await s.close();
  }
});

test('a download that has gone silent is abandoned', async () => {
  const s = await serving((_url, res) => {
    res.writeHead(200, { 'content-length': '999999' });
    res.write(Buffer.alloc(16, 1));
    // ...and then nothing, ever. Left alone this is a show stuck at "loading".
  });
  try {
    const started = Date.now();
    const result = await fetchAsset(`${s.base}/stalls.mp4`, () => {}, {
      attempts: 1,
      stallMs: 150,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.why, 'stalled');
    assert.ok(Date.now() - started < 5_000, 'gave up on the stall rather than hanging');
  } finally {
    await s.close();
  }
});

test('a slow but steady download is never abandoned for being large', async () => {
  // The regression this whole change exists for. The old clock was a flat
  // twenty seconds from the first byte, so the biggest assets — the ones a
  // scenario can least afford to lose — were the likeliest to be cut off. Here
  // every chunk is late enough that a deadline shorter than the whole transfer
  // would kill it, and none is late enough to be a stall.
  const chunks = 8;
  const s = await serving(async (_url, res) => {
    res.writeHead(200);
    for (let i = 0; i < chunks; i += 1) {
      await delay(60);
      res.write(Buffer.alloc(256, 9));
    }
    res.end();
  });
  try {
    let bytes = 0;
    const result = await fetchAsset(`${s.base}/big.mp4`, (n) => {
      bytes += n;
    }, { attempts: 1, stallMs: 200 });
    // Total transfer ~480ms against a 200ms watchdog: it survives because the
    // watchdog measures silence, not size.
    assert.equal(result.ok, true);
    assert.equal(bytes, chunks * 256);
  } finally {
    await s.close();
  }
});

test('a server that never answers at all is given up on, not waited on forever', async () => {
  const s = await serving(() => {
    // Accept the socket and say nothing.
  });
  try {
    const result = await fetchAsset(`${s.base}/silent.png`, () => {}, {
      attempts: 2,
      stallMs: 120,
      backoffMs: 1,
    });
    assert.equal(result.ok, false);
  } finally {
    await s.close();
  }
});
