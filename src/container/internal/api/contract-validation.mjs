export class ContractValidationError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
    this.metadata = Object.freeze({ category: code, ...metadata });
    Object.freeze(this);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateField(name, spec, rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return spec.required ? { code: 'API_RESPONSE_REQUIRED_FIELD_MISSING', field: name } : null;
  }
  if (spec.type === 'enum') {
    return spec.enum.includes(rawValue) ? null : { code: 'API_CONTRACT_INVALID', field: name };
  }
  if (spec.type && typeof rawValue !== spec.type) {
    return { code: 'API_CONTRACT_INVALID', field: name };
  }
  return null;
}

export function defineApiContract({ operation, supportedVersions, versionField = 'contractVersion', fields = {}, mapToDomain }) {
  function validate(rawBody) {
    if (!isPlainObject(rawBody)) {
      return { ok: false, code: 'API_RESPONSE_MALFORMED' };
    }

    const version = rawBody[versionField];
    if (typeof version !== 'string' || !supportedVersions.includes(version)) {
      return { ok: false, code: 'API_CONTRACT_VERSION_UNSUPPORTED', version };
    }

    for (const [name, spec] of Object.entries(fields)) {
      const failure = validateField(name, spec, rawBody[name]);
      if (failure) return { ok: false, ...failure, version };
    }

    let domain;
    try {
      domain = mapToDomain(rawBody, version);
    } catch {
      return { ok: false, code: 'API_CONTRACT_INVALID', version };
    }

    return { ok: true, data: Object.freeze({ ...domain }), version };
  }

  function parseResponse(rawBody) {
    const result = validate(rawBody);
    if (!result.ok) {
      throw new ContractValidationError(
        result.code,
        `Babysteps API contract validation failed for ${operation}: ${result.code}`,
        { operation, field: result.field, version: result.version }
      );
    }
    return Object.freeze({ ok: true, data: result.data });
  }

  return Object.freeze({ validate, parseResponse });
}
