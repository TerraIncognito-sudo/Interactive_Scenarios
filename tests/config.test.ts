import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrlFor, normalizePublicUrl } from '../server/config.ts';

describe('PUBLIC_URL normalisation', () => {
  test('supplies https for a bare hostname', () => {
    // Writing the hostname alone is the obvious mistake, and without a scheme
    // every generated link would be relative rather than absolute.
    assert.equal(normalizePublicUrl('interact.scurrycat.ca'), 'https://interact.scurrycat.ca');
  });

  test('leaves an explicit scheme alone', () => {
    assert.equal(normalizePublicUrl('https://a.example'), 'https://a.example');
    assert.equal(normalizePublicUrl('http://a.example:8880'), 'http://a.example:8880');
  });

  test('assumes http for a LAN address or localhost', () => {
    assert.equal(normalizePublicUrl('192.168.1.149:8880'), 'http://192.168.1.149:8880');
    assert.equal(normalizePublicUrl('localhost:8880'), 'http://localhost:8880');
  });

  test('strips trailing slashes so links do not double up', () => {
    assert.equal(normalizePublicUrl('https://a.example//'), 'https://a.example');
  });

  test('treats empty or missing as unset, so links follow the request', () => {
    assert.equal(normalizePublicUrl(undefined), undefined);
    assert.equal(normalizePublicUrl(''), undefined);
    assert.equal(normalizePublicUrl('   '), undefined);
  });
});

/**
 * Where a join link points.
 *
 * The relay is behind Cloudflare and does not guess its own interfaces — the
 * ranking that used to live here, and the terminal QR code it fed, went with
 * the server that ran shows off a laptop. What replaced it is smaller and
 * stronger: the link follows the request, so a LAN deployment and a proxied
 * one are both right with nothing configured.
 */
describe('the base URL a link is built on', () => {
  test('follows the request, so a LAN address yields LAN links', () => {
    assert.equal(baseUrlFor(undefined, { host: '192.168.1.149:8880' }), 'http://192.168.1.149:8880');
  });

  test('honours a proxy, so a Cloudflare request yields public links', () => {
    assert.equal(
      baseUrlFor(undefined, {
        host: 'relay.internal:8880',
        'x-forwarded-host': 'interact.example',
        'x-forwarded-proto': 'https',
      }),
      'https://interact.example',
    );
  });

  test('takes the first entry of a forwarded chain', () => {
    assert.equal(
      baseUrlFor(undefined, {
        'x-forwarded-host': 'interact.example, inner.proxy',
        'x-forwarded-proto': 'https, http',
      }),
      'https://interact.example',
    );
  });

  test('an explicit PUBLIC_URL wins outright', () => {
    assert.equal(
      baseUrlFor('https://set.example', { host: '192.168.1.149:8880' }),
      'https://set.example',
    );
  });

  test('a request with no host at all still produces an absolute URL', () => {
    // Never a bare path: a relative link would resolve against whatever page
    // happened to be open, which is how a join link once pointed at a phone.
    assert.equal(baseUrlFor(undefined, {}), 'http://localhost');
  });
});
