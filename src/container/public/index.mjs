export function defineLearningApp(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Learning app definition is required.');
  }
  if (typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Learning app id is required.');
  }
  return Object.freeze({ ...definition });
}

export const CONTAINER_RESPONSIBILITY_BOUNDARY = Object.freeze({
  platformAuthority: Object.freeze([
    'identity',
    'learner-authority',
    'access-entitlement',
    'subscription-billing',
    'session-credit-authority',
    'progress-persistence',
    'privacy',
    'administration',
  ]),
  containerOwns: Object.freeze(['reusable-runtime', 'platform-integration']),
  appOwns: Object.freeze(['curriculum-content', 'learning-logic', 'app-interactions', 'app-presentation']),
});
