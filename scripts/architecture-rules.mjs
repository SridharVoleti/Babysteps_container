const APP_PATH = /^(?:\.\/)?apps\//;

const RULES = [
  {
    code: 'CONTAINER_PRIVATE_IMPORT',
    message: 'Learning apps may import only public Consumer App Container interfaces.',
    test: (source) => /(?:from\s*|import\s*(?:\(|\s))['"][^'"]*(?:src\/container\/internal|container\/internal)[^'"]*['"]/.test(source),
  },
  {
    code: 'DIRECT_PLATFORM_DATA_ACCESS',
    message: 'Learning apps must not instantiate Supabase/database clients or import platform client internals.',
    test: (source) => /@supabase\/supabase-js|createClient\s*\(|\.supabase\.co\b|\/rest\/v1\/|(?:src\/)?platform-client\//.test(source),
  },
  {
    code: 'DIRECT_PLATFORM_PRIVATE_ENDPOINT',
    message: 'Learning apps must not call Babysteps platform/private endpoints directly; use container capabilities.',
    test: (source) => /(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\([^\n]*(?:api\.)?babysteps[^\n]*(?:\/internal\/|\/private\/|\/billing(?:\/|['"]))/i.test(source),
  },
  {
    code: 'DIRECT_BABYSTEPS_API_CALL',
    message: 'Learning apps must not call Babysteps Platform APIs directly; use the centralized Babysteps API client via container capabilities.',
    test: (source) => /(?:fetch|axios(?:\.(?:get|post|put|patch|delete))?)\s*\([^\n]*babysteps/i.test(source),
  },
  {
    code: 'DIRECT_NETWORK_ACCESS_DENIED',
    message: 'Learning apps must not perform raw network requests of any kind; use container-owned capability adapters. This is deny-by-default and applies regardless of the target host.',
    test: (source) => /\bfetch\s*\(|\baxios(?:\s*\.\s*[a-zA-Z]+)?\s*\(|\bnew\s+XMLHttpRequest\s*\(|\bhttp\s*\.\s*request\s*\(|\bhttps\s*\.\s*request\s*\(|navigator\s*\.\s*sendBeacon\s*\(|\bnew\s+WebSocket\s*\(|\bnew\s+EventSource\s*\(/.test(source),
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
