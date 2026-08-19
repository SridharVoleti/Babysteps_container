// Test fixture only: records that this module's top-level code ran, so tests can prove
// whether a given loadApprovedExtensionModule() call actually imported it or not.
globalThis.__CC004_SIDE_EFFECT_EXTENSION_IMPORT_COUNT__ = (globalThis.__CC004_SIDE_EFFECT_EXTENSION_IMPORT_COUNT__ ?? 0) + 1;

export default {
  type: 'activity-renderer',
  version: '1.0',
  id: 'side-effect-fixture',
  initialize: async () => ({ dispose() {} }),
};
