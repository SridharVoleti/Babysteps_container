/**
 * @typedef {Object} CapabilityFacade
 * @property {(name: string) => Readonly<object>} get
 * @property {(name: string) => boolean} has
 * @property {() => readonly string[]} list
 */

/**
 * Public app-facing capability access. The container creates the facade;
 * learning apps only consume declared capabilities through this function.
 * @param {CapabilityFacade} facade
 * @param {string} capabilityName
 */
export function getCapability(facade, capabilityName) {
  if (!facade || typeof facade.get !== 'function') {
    throw new TypeError('Container capability facade is required.');
  }
  return facade.get(capabilityName);
}

export const CAPABILITY_CONTRACT_VERSION = '1.0';
