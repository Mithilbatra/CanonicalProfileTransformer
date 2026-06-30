'use strict';

const N = require('./normalize');

function project(record, config) {
  const onMissing = config.on_missing || 'null';
  const out = {};
  const issues = [];

  for (const field of config.fields || []) {
    const fromPath = field.from || field.path;
    let value = resolvePath(record, fromPath);

    value = applyNormalize(value, field.normalize);

    const missing = isMissing(value);
    if (missing) {
      if (onMissing === 'error') {
        const err = new Error(
          `on_missing="error": required value for field "${field.path}" is missing (resolved from "${fromPath}")`
        );
        err.code = 'PROJECTION_MISSING_FIELD';
        err.field = field.path;
        throw err;
      }
      if (onMissing === 'omit') continue;
      out[field.path] = null;
      if (field.required) issues.push(`required field "${field.path}" resolved to null`);
      continue;
    }

    const coerced = coerceType(value, field.type);
    if (coerced.error) {
      issues.push(`field "${field.path}": ${coerced.error}`);
      out[field.path] = onMissing === 'omit' ? undefined : null;
      if (out[field.path] === undefined) delete out[field.path];
      continue;
    }
    out[field.path] = coerced.value;
  }

  if (config.include_provenance) {
    out.provenance = record.provenance;
  }
  if (config.include_confidence) {
    out.overall_confidence = record.overall_confidence;
    if (config.include_field_confidence && record.__fieldConfidence) {
      out.field_confidence = record.__fieldConfidence;
    }
  }

  return { output: out, issues };
}

function resolvePath(obj, path) {
  if (!path) return undefined;
  const tokens = path.split('.');
  let cur = [obj];
  let fannedOut = false;

  for (const token of tokens) {
    const m = token.match(/^([A-Za-z0-9_]+)(\[(\d*)\])?$/);
    if (!m) return undefined;
    const key = m[1];
    const hasBracket = m[2] !== undefined;
    const idx = m[3] === '' ? null : (m[3] !== undefined ? parseInt(m[3], 10) : undefined);

    const next = [];
    for (const node of cur) {
      if (node == null) continue;
      const v = node[key];
      if (v === undefined) continue;
      if (!hasBracket) {
        next.push(v);
      } else if (idx === null) {
        if (Array.isArray(v)) { next.push(...v); fannedOut = true; }
      } else {
        if (Array.isArray(v) && idx < v.length) next.push(v[idx]);
      }
    }
    cur = next;
    if (cur.length === 0) return fannedOut ? [] : undefined;
  }

  if (fannedOut) return cur;
  return cur.length === 1 ? cur[0] : cur;
}

function applyNormalize(value, norm) {
  if (value == null || !norm) return value;
  const one = (v) => {
    switch (norm) {
      case 'E164': return N.normalizePhone(v);
      case 'lowercase': return String(v).toLowerCase();
      case 'uppercase': return String(v).toUpperCase();
      case 'canonical': return v;
      default: return v;
    }
  };
  return Array.isArray(value) ? value.map(one).filter((v) => v != null) : one(value);
}

function coerceType(value, type) {
  if (!type) return { value };
  switch (type) {
    case 'string':
      if (Array.isArray(value)) return { error: 'expected string, got array' };
      return { value: String(value) };
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? { value: n } : { error: 'expected number' };
    }
    case 'boolean':
      return { value: Boolean(value) };
    case 'string[]': {
      const arr = Array.isArray(value) ? value : [value];
      return { value: arr.map(String) };
    }
    case 'object':
      return typeof value === 'object' ? { value } : { error: 'expected object' };
    case 'array':
      return Array.isArray(value) ? { value } : { error: 'expected array' };
    default:
      return { value };
  }
}

function isMissing(v) {
  if (v == null) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

module.exports = { project, resolvePath };
