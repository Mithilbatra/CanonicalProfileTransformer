'use strict';

const { detect } = require('./detect');
const { extractCsv } = require('./extract/csv');
const { extractAts } = require('./extract/ats');
const { extractGithub, fetchGithub } = require('./extract/github');
const { extractNotes } = require('./extract/notes');
const { extractLinkedin } = require('./extract/linkedin');
const { mergeAll } = require('./merge');
const { project } = require('./project');
const { validateCanonical, validateProjection } = require('./validate');
const DEFAULT_CONFIG = require('../../configs/default.json');

async function runPipeline(sources, config = DEFAULT_CONFIG, opts = {}) {
  const sourceResults = [];
  const sourceReport = [];

  for (const src of sources) {
    const type = detect(src);
    let result;
    try {
      result = await extractOne(type, src, opts);
    } catch (err) {
      result = { sourceId: src.name || type, sourceType: type, ok: false, error: String(err.message || err), subjects: [] };
    }
    sourceResults.push(result);
    sourceReport.push({
      source: result.sourceId,
      type: result.sourceType,
      ok: result.ok,
      error: result.error || null,
      subjects: result.subjects.length,
    });
  }

  const records = mergeAll(sourceResults);

  const profiles = records.map((record) => {
    const canonicalCheck = validateCanonical(record);
    const { output, issues } = project(record, config);
    const projectionCheck = validateProjection(output, config);
    return {
      output,
      canonical_valid: canonicalCheck.valid,
      canonical_errors: canonicalCheck.errors,
      projection_valid: projectionCheck.valid && issues.length === 0,
      projection_errors: [...issues, ...projectionCheck.errors],
      _record: record,
    };
  });

  return { profiles, sources: sourceReport };
}

async function extractOne(type, src, opts) {
  switch (type) {
    case 'csv':
      return extractCsv(src.content, src.name || 'recruiter_csv');
    case 'ats':
      return extractAts(src.content, src.name || 'ats_json');
    case 'notes':
      return extractNotes(src.content, src.name || 'recruiter_notes');
    case 'linkedin':
      return extractLinkedin(src.content, src.name || 'linkedin');
    case 'github': {
      if (src.content && /[{[]/.test(String(src.content).trim()[0] || '')) {
        return extractGithub(JSON.parse(src.content), src.name || 'github');
      }
      const handle = src.url || src.content || src.name;
      if (opts.allowNetwork) {
        const data = await fetchGithub(handle);
        return extractGithub(data, src.name || 'github');
      }
      return { sourceId: src.name || 'github', sourceType: 'github', ok: false, error: 'github fetch disabled (no allowNetwork) and no inline blob', subjects: [] };
    }
    default:
      return { sourceId: src.name || 'unknown', sourceType: 'unknown', ok: false, error: `unsupported source type "${type}"`, subjects: [] };
  }
}

module.exports = { runPipeline, DEFAULT_CONFIG };
