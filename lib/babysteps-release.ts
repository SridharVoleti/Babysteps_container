// Shared, deployment-wide release identifier. Both the Babysteps Platform API (the launch
// issuer, app/api/v1/sessions/route.ts) and the host/runtime layer (SB-001 launch validation,
// lib/host/bootstrap-chessmaster.ts) must agree on this value — it is not data access, just a
// version label, so sharing it directly does not cross the "host talks to the platform only
// over HTTP" boundary (that boundary is about Supabase access, not string constants).
export const CHESSMASTER_RELEASE_ID = 'chessmaster-dev-release-1'
