const APP_PATH = /^(?:\.\/)?apps\//;

const RULES = [
  {
    code: 'CONTAINER_PRIVATE_IMPORT',
    message: 'Learning apps may import only public Consumer App Container interfaces.',
    test: (source) => /(?:from\s*|import\s*\()['"][^'"]*(?:src\/container\/internal|container\/internal)[^'"]*['"]/.test(source),
  },
  {
    code: 'DIRECT_PLATFORM_DATA_ACCESS',
    message: 'Learning apps must not instantiate Supabase/database clients or access platform data endpoints directly.',
    test: (source) => /@supabase\/supabase-js|createClient\s*\(|\.supabase\.co\b|\/rest\/v1\/|(?:src\/)?platform-client\//.test(source),
  },
  {
    code: 'PLATFORM_AUTHORITY_REIMPLEMENTATION',
    message: 'Identity, entitlement, subscription, session/credit authority and progress persistence remain platform/container owned.',
    test: (source) => /\b(?:function|const|let|var)\s+(?:decide|determine|validate|check|calculate|compute)(?:LearnerOwnership|Entitlement|Subscription|SessionEligibility|SessionCredit|CreditEligibility)\b/i.test(source),
  },
];

export function inspectSource(filePath, source) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  if (!APP_PATH.test(normalizedPath)) return [];

  return RULES.filter((rule) => rule.test(source)).map(({ code, message }) => ({
    code,
    message,
    filePath: normalizedPath,
  }));
}

export const architectureRules = Object.freeze(RULES.map(({ code, message }) => Object.freeze({ code, message })));
