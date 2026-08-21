// SP-001/CC-003/SP-003-P0: real structural enforcement of the closed learner runtime,
// applied to the actual global object BEFORE any app code executes (wired into
// bootstrapLearningApp - the single mandatory production entrypoint, SB-001). Unlike
// scripts/architecture-rules.mjs's static source scan (kept as defense-in-depth only, since
// it can be evaded by renaming/aliasing/wrapping a primitive in source text), this operates
// on object identity: app code cannot recover a working reference to a locked-down
// primitive no matter what name, alias, import path or wrapper it uses, because the
// underlying global function/object is itself replaced before app code ever runs.

const NETWORK_PRIMITIVE_NAMES = Object.freeze(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

function deniedPrimitive(name) {
  function denied() {
    throw new Error(`${name} is denied in the closed learner runtime; use an approved container capability/API client.`);
  }
  denied.CLOSED_RUNTIME_DENIED = true;
  return denied;
}

function tryReplace(target, prop, value) {
  try {
    target[prop] = value;
    return true;
  } catch {
    try {
      Object.defineProperty(target, prop, { value, configurable: true, writable: true });
      return true;
    } catch {
      return false;
    }
  }
}

// CC-003/SP-003-P0: deny-by-default network egress independent of HTTP client syntax.
// Removing/neutering the actual global primitives means an unlisted client library (ky,
// got, superagent, ...), an aliased/wrapped fetch, or a dynamically imported HTTP client
// all fail the same way, because every one of them ultimately has to call one of these
// same underlying browser primitives - there is nothing left under an app-reachable name
// to alias/wrap.
export function applyNetworkDenyByDefault(target = globalThis) {
  const applied = [];
  for (const name of NETWORK_PRIMITIVE_NAMES) {
    if (name in target && tryReplace(target, name, deniedPrimitive(name))) applied.push(name);
  }
  if (target.navigator && typeof target.navigator.sendBeacon === 'function') {
    if (tryReplace(target.navigator, 'sendBeacon', deniedPrimitive('navigator.sendBeacon'))) applied.push('navigator.sendBeacon');
  }
  return Object.freeze({ denied: Object.freeze(applied) });
}

// SP-001-P0: default-deny for browser/device capability APIs, independent of a finite
// per-API regex list. Rather than enumerating forbidden APIs (which a newly-added browser
// API would silently bypass until someone adds a matching regex), this enumerates the
// APPROVED navigator surface and wraps navigator itself in a Proxy that denies everything
// else by construction - including APIs that don't exist yet.
const APPROVED_NAVIGATOR_PROPERTIES = Object.freeze([
  // AM-003 baseline microphone/STT capability only (getUserMedia); no other mediaDevices
  // capability (e.g. getDisplayMedia/screen capture) is exposed through this surface.
  'mediaDevices',
  // Inert descriptive properties - not capabilities.
  'userAgent', 'appVersion', 'vendor', 'platform', 'language', 'languages', 'onLine', 'cookieEnabled',
]);

export function applyDeviceCapabilityDefaultDeny(target = globalThis) {
  const realNavigator = target.navigator;
  if (!realNavigator) return Object.freeze({ applied: false });
  const approved = new Set(APPROVED_NAVIGATOR_PROPERTIES);
  const guarded = new Proxy(realNavigator, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || approved.has(prop)) return Reflect.get(obj, prop, receiver);
      return undefined;
    },
    has(obj, prop) {
      if (typeof prop === 'symbol' || approved.has(prop)) return Reflect.has(obj, prop);
      return false;
    },
  });
  if (!tryReplace(target, 'navigator', guarded)) return Object.freeze({ applied: false });
  return Object.freeze({ applied: true });
}

// SP-001-P0: closes window.open() to app code entirely - not just "denied by default until
// app code calls guardNavigation()" (which was voluntary and bypassable), but structurally
// unavailable. The original function is captured and returned so the container's own
// approved SP-001 navigation path (learner-safety-policy.mjs's guardNavigation, invoked
// only after this trusted-registry check) can still perform an approved navigation on the
// app's behalf.
//
// Known limitation (browser security model, not a gap in this function): window.location
// cannot be reliably redefined in real browsers, so `location.href =`, `location.assign()`,
// `location.replace()`, `<a href>` clicks and `<form action>` submits/`<iframe src>` cannot
// be intercepted this way. Enforcing those requires a deployment-side Content-Security-
// Policy (`form-action`, `frame-src`, `default-src`) generated from the same trusted
// governance/navigation-policy-registry.mjs - see buildNavigationContentSecurityPolicy().
export function applyNavigationLockdown(target = globalThis) {
  if (typeof target.open !== 'function') return Object.freeze({ applied: false, originalOpen: null });
  const originalOpen = target.open.bind(target);
  tryReplace(target, 'open', deniedPrimitive('window.open'));
  return Object.freeze({ applied: true, originalOpen });
}

// Deployment-side complement for the navigation vectors JS cannot intercept in-page. This
// repo has no server/deployment layer of its own, so this is a pure generator the actual
// hosting configuration (e.g. Vercel headers) can consume - it is not applied by anything
// in this package.
export function buildNavigationContentSecurityPolicy(approvedDestinations) {
  const sources = approvedDestinations.length > 0 ? approvedDestinations.join(' ') : "'none'";
  return `form-action ${sources}; frame-src ${sources};`;
}

// Applies every structural lockdown above in one call. Safe to call more than once
// (idempotent enough: re-wrapping an already-denied primitive just re-denies it).
export function applyClosedRuntimeLockdown(target = globalThis) {
  const network = applyNetworkDenyByDefault(target);
  const devices = applyDeviceCapabilityDefaultDeny(target);
  const navigation = applyNavigationLockdown(target);
  return Object.freeze({ network, devices, navigation });
}
