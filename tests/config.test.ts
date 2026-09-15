import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, normalizePublicUrl } from '../server/config.ts';

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

const ipv4 = (address: string, internal = false) => ({ family: 'IPv4', address, internal });

describe('LAN address ranking', () => {
  test('prefers a real LAN address over a VPN adapter', () => {
    // The shape that actually caused a wrong QR code on the dev machine.
    const ranked = rankCandidates({
      NordLynx: [ipv4('10.5.0.2')],
      'Wi-Fi': [ipv4('192.168.1.89')],
    });
    assert.equal(ranked[0]?.address, '192.168.1.89');
  });

  test('prefers a real LAN address over WSL and Docker adapters', () => {
    const ranked = rankCandidates({
      'vEthernet (WSL)': [ipv4('172.28.144.1')],
      'vEthernet (Default Switch)': [ipv4('172.17.0.1')],
      Ethernet: [ipv4('192.168.0.42')],
    });
    assert.equal(ranked[0]?.address, '192.168.0.42');
  });

  test('never picks a link-local address, which means DHCP failed', () => {
    const ranked = rankCandidates({
      Ethernet: [ipv4('169.254.13.7')],
      'Wi-Fi': [ipv4('10.0.0.5')],
    });
    assert.equal(ranked[0]?.address, '10.0.0.5');
  });

  test('ignores loopback and IPv6', () => {
    const ranked = rankCandidates({
      lo: [ipv4('127.0.0.1', true)],
      eth0: [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        ipv4('192.168.5.5'),
      ],
    });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.address, '192.168.5.5');
  });

  test('still returns something when only a virtual adapter exists', () => {
    // Better to offer a wrong-looking address than none at all — the operator
    // is shown the alternatives and can override with PUBLIC_URL.
    const ranked = rankCandidates({ 'vEthernet (WSL)': [ipv4('172.28.144.1')] });
    assert.equal(ranked[0]?.address, '172.28.144.1');
  });

  test('returns nothing when there is no usable interface', () => {
    assert.deepEqual(rankCandidates({ lo: [ipv4('127.0.0.1', true)] }), []);
  });

  test('ranks 192.168 above 172.16-31 above 10.x', () => {
    const ranked = rankCandidates({
      a: [ipv4('10.1.2.3')],
      b: [ipv4('172.20.1.1')],
      c: [ipv4('192.168.9.9')],
    });
    assert.deepEqual(
      ranked.map((r) => r.address),
      ['192.168.9.9', '172.20.1.1', '10.1.2.3'],
    );
  });
});
