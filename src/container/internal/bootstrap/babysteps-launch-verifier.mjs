export class LaunchVerifierError extends Error {
  constructor(code, message) { super(message); this.name = 'LaunchVerifierError'; this.code = code; Object.freeze(this); }
}

function canonicalizeClaims(claims) {
  return JSON.stringify(claims, Object.keys(claims).sort());
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

const IMPORT_ALGORITHM = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const VERIFY_ALGORITHM = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function isValidKid(value) {
  return typeof value === 'string' && KID_PATTERN.test(value);
}

function isPublicEcJwk(jwk) {
  return !!jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && jwk.d === undefined;
}

// SB-001: container-owned production verifier for the Babysteps-issued launch envelope.
// The container is configured with ONLY Babysteps' published public verification key(s)
// (ECDSA P-256 JWK, keyed by `kid` to support rotation) - it holds no signing capability at
// all. Extracting every piece of client-side verification configuration shipped in the
// final learning app is therefore insufficient to mint a valid launch proof: only whoever
// holds the matching Babysteps-side private key can produce a signature this module accepts.
// Uses WebCrypto (globalThis.crypto.subtle), a browser-native primitive also available in
// Node, so this module has no Node-only runtime dependency (DR-001).
export function createBabystepsLaunchVerifier({ publicKeys } = {}) {
  if (!publicKeys || typeof publicKeys !== 'object' || Array.isArray(publicKeys)) {
    throw new LaunchVerifierError('LAUNCH_VERIFIER_MISCONFIGURED', 'A production launch verifier requires a map of kid -> Babysteps public key (JWK).');
  }
  const kids = Object.keys(publicKeys);
  if (kids.length === 0) {
    throw new LaunchVerifierError('LAUNCH_VERIFIER_MISCONFIGURED', 'At least one Babysteps public verification key is required.');
  }
  for (const kid of kids) {
    if (!isValidKid(kid) || !isPublicEcJwk(publicKeys[kid])) {
      throw new LaunchVerifierError('LAUNCH_VERIFIER_MISCONFIGURED', `Public key for kid "${kid}" is not a valid public P-256 EC JWK.`);
    }
  }

  const importedKeys = new Map();
  async function importedKeyFor(kid) {
    if (importedKeys.has(kid)) return importedKeys.get(kid);
    const jwk = publicKeys[kid];
    const key = jwk ? await crypto.subtle.importKey('jwk', jwk, IMPORT_ALGORITHM, false, ['verify']).catch(() => null) : null;
    importedKeys.set(kid, key);
    return key;
  }

  return async function verifyBabystepsLaunchContext(launchContext) {
    try {
      if (!launchContext || typeof launchContext !== 'object') return Object.freeze({ ok: false });
      const { claims, proof, kid } = launchContext;
      if (!claims || typeof claims !== 'object' || Array.isArray(claims) || typeof proof !== 'string' || proof.length === 0 || !isValidKid(kid)) {
        return Object.freeze({ ok: false });
      }

      const signatureBytes = hexToBytes(proof);
      if (!signatureBytes || signatureBytes.length !== 64) return Object.freeze({ ok: false });

      const key = await importedKeyFor(kid);
      if (!key) return Object.freeze({ ok: false });

      const data = new TextEncoder().encode(canonicalizeClaims(claims));
      const verified = await crypto.subtle.verify(VERIFY_ALGORITHM, key, signatureBytes, data);
      return verified ? Object.freeze({ ok: true, claims }) : Object.freeze({ ok: false });
    } catch {
      // Any unexpected verification failure fails closed rather than throwing, matching
      // the {ok:false} contract validateLaunchContext() expects from every verifier.
      return Object.freeze({ ok: false });
    }
  };
}
