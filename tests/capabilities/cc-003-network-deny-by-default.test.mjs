import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSource } from '../../scripts/architecture-rules.mjs';

function violates(source, code = 'DIRECT_NETWORK_ACCESS_DENIED') {
  return inspectSource('apps/demo/index.mjs', source).some((v) => v.code === code);
}

test('CC-003-AC06 direct calls to any Babysteps platform/API host are rejected regardless of endpoint path', () => {
  assert.equal(violates("fetch('https://api.babysteps.com/v1/public/leaderboard')"), true, 'public-looking endpoint');
  assert.equal(violates("fetch('https://api.babysteps.com/internal/session')"), true, 'internal endpoint');
  assert.equal(violates("fetch('https://api.babysteps.com/billing/charge')"), true, 'billing endpoint');
  assert.equal(violates("fetch('https://api.babysteps.com/v2026-08/session/finalize')"), true, 'versioned endpoint');
  assert.equal(
    violates("const host = 'api'; const base = `https://${host}.babysteps.com/v1`; fetch(base + '/progress')"),
    true,
    'dynamically composed URL'
  );
});

test('CC-003-AC06 approved network access remains available only to container-owned capability adapters, not app code', () => {
  // Container-owned adapters live under src/container/internal and are not "apps/**" source,
  // so the same deny-by-default rule does not apply to them.
  assert.deepEqual(inspectSource('src/container/internal/api/babysteps-api-client.mjs', "fetch('https://api.babysteps.com/v1/progress')"), []);
});

test('CC-003-AC07 alternate HTTP client syntax is covered by the deny-by-default rule', () => {
  assert.equal(violates("const req = new XMLHttpRequest(); req.open('GET', 'https://api.babysteps.com/v1/progress');"), true, 'XMLHttpRequest');
  assert.equal(violates("navigator.sendBeacon('https://api.babysteps.com/v1/progress', payload);"), true, 'sendBeacon');
  assert.equal(violates("const ws = new WebSocket('wss://api.babysteps.com/v1/stream');"), true, 'WebSocket');
  assert.equal(violates("const es = new EventSource('https://api.babysteps.com/v1/stream');"), true, 'EventSource');
  assert.equal(violates("const http = require('node:http'); http.request('https://api.babysteps.com/v1/progress');"), true, 'http.request');
  assert.equal(violates("axios.post('https://api.babysteps.com/v1/progress', payload);"), true, 'axios verb call');
  assert.equal(violates("axios('https://api.babysteps.com/v1/progress');"), true, 'bare axios call');
});

test('CC-003-AC08 a raw-fetch fallback written for when a capability fails is still denied', () => {
  const source = `
    async function saveProgress(capability, payload) {
      try {
        return await capability.progress.save(payload);
      } catch {
        // not permitted: falling back to a direct call when the capability fails
        return fetch('https://api.babysteps.com/v1/progress', { method: 'POST', body: JSON.stringify(payload) });
      }
    }
  `;
  assert.equal(violates(source), true);
});
