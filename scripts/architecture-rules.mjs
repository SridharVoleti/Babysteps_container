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
  {
    code: 'BROWSER_DETECTION_BYPASS',
    message: 'Learning apps must not implement independent browser-name/user-agent detection; use the shared DR-001 runtime capability service.',
    test: (source) => /navigator\s*\.\s*(?:userAgent|appVersion|vendor|platform)\b/.test(source),
  },
  {
    code: 'RESTRICTED_DEVICE_CAPABILITY_ACCESS',
    message: 'Learning apps must not access contacts, camera/microphone, geolocation or file-system capabilities directly; microphone/STT is approved only through AM-003 and no other device capability is approved.',
    test: (source) => /navigator\s*\.\s*(?:geolocation|contacts)\b|getUserMedia\s*\(|showOpenFilePicker\s*\(|type\s*=\s*['"]file['"]/.test(source),
  },
  {
    code: 'UNRESTRICTED_EXTERNAL_NAVIGATION',
    message: 'Learning apps must not open arbitrary external navigation/deep links/popups/new browser contexts; use the approved shared SP-001 navigation guard.',
    test: (source) => /window\s*\.\s*open\s*\(|\bnew\s+Window\s*\(/.test(source),
  },
  {
    code: 'LEARNER_FACING_GENERATIVE_AI',
    message: 'Learner-facing generative/open-ended AI is not approved for the closed learner runtime.',
    test: (source) => /from\s+['"](?:openai|@anthropic-ai\/sdk|@google\/generative-ai)['"]/.test(source),
  },
  {
    code: 'UNAPPROVED_NETWORK_SDK_IMPORT',
    message: 'Learning apps must not import third-party analytics/tracking SDKs directly; use an SP-003 explicitly approved shared provider adapter.',
    test: (source) => /from\s+['"](?:react-ga\d*|@segment\/analytics-next|mixpanel-browser|amplitude-js|@amplitude\/analytics-browser|@sentry\/browser|@sentry\/react)['"]/.test(source),
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
