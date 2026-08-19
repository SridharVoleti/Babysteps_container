import { createHmac, timingSafeEqual } from 'node:crypto';

export class LaunchVerifierError extends Error {
  constructor(code, message) { super(message); this.name = 'LaunchVerifierError'; this.code = code; Object.freeze(this); }
}

function canonicalizeClaims(claims) {
  return JSON.stringify(claims, Object.keys(claims).sort());
}

function sign(claims, key) {
  return createHmac('sha256', key).update(canonicalizeClaims(claims)).digest();
}

function constantTimeEquals(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Container-owned production verifier for the Babysteps-issued launch envelope (SB-001).
// The container never sees or stores learner/parent credentials; it only verifies that the
// claims were signed by a Babysteps-held key. Keeps raw key/proof material out of every
// return value and error so it can never leak into runtime context or app-visible errors.
export function createBabystepsLaunchVerifier({ verificationKey, previousVerificationKeys = [] } = {}) {
  if (typeof verificationKey !== 'string' || verificationKey.length < 32) {
    throw new LaunchVerifierError(
      'LAUNCH_VERIFIER_MISCONFIGURED',
      'A production launch verifier requires a configured verification key of sufficient length.'
    );
  }
  if (!Array.isArray(previousVerificationKeys) || previousVerificationKeys.some((key) => typeof key !== 'string' || key.length < 32)) {
    throw new LaunchVerifierError('LAUNCH_VERIFIER_MISCONFIGURED', 'previousVerificationKeys must be an array of valid verification keys.');
  }

  const keys = Object.freeze([verificationKey, ...previousVerificationKeys]);

  return async function verifyBabystepsLaunchContext(launchContext) {
    try {
      if (!launchContext || typeof launchContext !== 'object') return Object.freeze({ ok: false });
      const { claims, proof } = launchContext;
      if (!claims || typeof claims !== 'object' || Array.isArray(claims) || typeof proof !== 'string' || proof.length === 0) {
        return Object.freeze({ ok: false });
      }

      let candidateProof;
      try {
        candidateProof = Buffer.from(proof, 'hex');
      } catch {
        return Object.freeze({ ok: false });
      }
      if (candidateProof.length !== 32) return Object.freeze({ ok: false });

      for (const key of keys) {
        if (constantTimeEquals(candidateProof, sign(claims, key))) {
          return Object.freeze({ ok: true, claims });
        }
      }
      return Object.freeze({ ok: false });
    } catch {
      // Any unexpected verification failure fails closed rather than throwing, matching
      // the {ok:false} contract validateLaunchContext() expects from every verifier.
      return Object.freeze({ ok: false });
    }
  };
}
