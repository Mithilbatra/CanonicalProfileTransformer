'use strict';

const llm = require('./lib/llm');
const { CANON } = require('./engine/skills');
const { extractRequirements, scoreCandidate, estimateTenureYears } = require('./engine/match');
const { suggestImprovements } = require('./engine/suggest');

// The AI intelligence layer. Design rule, in keeping with the rest of the
// engine: the model does only the *language* work — understanding a recruiter's
// natural-language search, drafting a brief, writing interview questions or an
// outreach note. All ranking and filtering stays in the deterministic,
// explainable engine (scoreCandidate), so search results are still auditable
// number-by-number. Every feature also has a deterministic local fallback, so
// the flows work with no API key (mock mode) or if a live call fails.
//
// None of this is written back into the trusted canonical record. These are
// drafts, clearly attributed (mode: live | mock | fallback), for a human.

const FEATURES = ['search', 'summary', 'interview-kit', 'outreach'];

// ---- small shared helpers -------------------------------------------------

function yearsOf(record) {
  return record.years_experience != null ? record.years_experience : estimateTenureYears(record.experience || []);
}

// Skill names, strongest evidence first.
function topSkillNames(record, n) {
  return [...(record.skills || [])]
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, n)
    .map((s) => s.name);
}

function firstName(fullName) {
  const t = String(fullName || '').trim().split(/\s+/)[0];
  return t || null;
}

function arrOfStr(x, n = 6) {
  if (!Array.isArray(x)) return [];
  return x.map((v) => String(v).trim()).filter(Boolean).slice(0, n);
}

// Tolerant JSON reader: exact parse, else the first {...} span in the text.
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* give up */ }
  }
  return null;
}

// A compact, grounded view of the record for a prompt — only the fields the
// language task needs, arrays bounded so the prompt stays small.
function profileForPrompt(record) {
  return {
    full_name: record.full_name || null,
    headline: record.headline || null,
    years_experience: yearsOf(record),
    location: record.location || null,
    skills: (record.skills || []).slice(0, 25).map((s) => ({ name: s.name, confidence: s.confidence })),
    experience: (record.experience || []).slice(0, 8).map((e) => ({
      title: e.title || null, company: e.company || null, start: e.start || null, end: e.end || null, summary: e.summary || null,
    })),
    education: (record.education || []).slice(0, 5),
    projects: (record.projects || []).slice(0, 8).map((p) => ({ name: p.name, tech: p.tech || [], summary: p.summary || null })),
    certifications: (record.certifications || []).slice(0, 8),
    links: record.links || {},
  };
}

// ---- candidate summary ----------------------------------------------------

const SUMMARY_SYSTEM =
  'You assist a technical recruiter. From the structured candidate profile you are given, write a short, factual brief. ' +
  'Ground every statement in the data provided — never invent employers, skills, dates, or achievements that are not present. ' +
  'If the profile is thin, say so plainly rather than padding.';

function summaryFallback(record) {
  const name = record.full_name || 'This candidate';
  const years = yearsOf(record);
  const skills = topSkillNames(record, 6);
  const recent = (record.experience || [])[0];
  const bits = [`${name}${record.headline ? ` — ${record.headline}` : ''}.`];
  if (years != null) bits.push(`About ${years} year${years === 1 ? '' : 's'} of experience.`);
  if (skills.length) bits.push(`Core skills: ${skills.join(', ')}.`);
  if (recent && recent.company) bits.push(`Most recent: ${recent.title || 'role'} at ${recent.company}.`);

  const strengths = [];
  const strong = (record.skills || []).filter((s) => (s.confidence || 0) >= 0.7).map((s) => s.name);
  if (strong.length) strengths.push(`Well-supported skills: ${strong.slice(0, 5).join(', ')}`);
  const multi = (record.skills || []).filter((s) => (s.sources || []).length > 1).length;
  if (multi) strengths.push(`${multi} skill${multi === 1 ? '' : 's'} corroborated across multiple sources`);
  if (record.links && record.links.github) strengths.push('Public GitHub profile to verify code');
  if ((record.projects || []).length) strengths.push(`${record.projects.length} project${record.projects.length === 1 ? '' : 's'} listed`);

  const gaps = suggestImprovements(record, {}).slice(0, 3).map((s) => s.message);
  return { summary: bits.join(' '), strengths: strengths.slice(0, 4), gaps };
}

async function summarize(record) {
  const fallback = summaryFallback(record);
  if (llm.mode() !== 'live') return { mode: llm.mode(), model: null, ...fallback };

  const prompt =
    `Candidate profile (JSON):\n${JSON.stringify(profileForPrompt(record))}\n\n` +
    'Return ONLY a JSON object of the shape:\n' +
    '{"summary": "2-3 sentence recruiter brief", "strengths": ["short phrase", ...up to 4], "gaps": ["what to probe or what is missing", ...up to 3]}';
  try {
    const { model, text } = await llm.complete({ system: SUMMARY_SYSTEM, prompt });
    const j = parseJsonLoose(text);
    if (!j || typeof j.summary !== 'string' || !j.summary.trim()) {
      return { mode: 'live', model, ...fallback, note: 'showing a local draft (could not parse the model output)' };
    }
    return { mode: 'live', model, summary: j.summary.trim(), strengths: arrOfStr(j.strengths, 4), gaps: arrOfStr(j.gaps, 3) };
  } catch (err) {
    return { mode: 'fallback', model: null, ...fallback, ai_error: err.message };
  }
}

// ---- interview kit --------------------------------------------------------

const KIT_SYSTEM =
  'You assist a technical recruiter preparing to screen a candidate. From the structured profile (and role context, if given), ' +
  'write focused interview questions grouped by area. Base questions on what is actually in the profile so they can be answered ' +
  'from the candidate\'s real background; where the role needs something the profile does not show, write a question that probes it. ' +
  'Do not invent facts about the candidate.';

function interviewKitFallback(record, { jobText } = {}) {
  const groups = [];
  const skills = topSkillNames(record, 4);
  if (skills.length) {
    groups.push({
      area: 'Technical depth',
      questions: skills.map((s) => `Walk me through a project where you used ${s}. What was the hardest problem, and how did you solve it?`),
    });
  }
  const recent = (record.experience || [])[0];
  if (recent && recent.company) {
    groups.push({
      area: 'Experience',
      questions: [
        `Tell me about your work at ${recent.company}. What were you responsible for and what did you ship?`,
        'Describe a time a project didn\'t go to plan. What did you change?',
      ],
    });
  }
  if (jobText) {
    const scored = scoreCandidate(record, extractRequirements(jobText));
    const miss = (scored.missingRequired || []).slice(0, 3);
    if (miss.length) {
      groups.push({
        area: 'Role fit — probe gaps',
        questions: miss.map((m) => `This role calls for ${m}, which we didn't see in the profile. What's your experience with it?`),
      });
    }
  }
  if (!groups.length) {
    groups.push({ area: 'General', questions: ['Tell me about a recent project you\'re proud of.', 'What kind of role are you looking for next?'] });
  }
  return { groups };
}

async function interviewKit(record, { jobText } = {}) {
  const fallback = interviewKitFallback(record, { jobText });
  if (llm.mode() !== 'live') return { mode: llm.mode(), model: null, ...fallback };

  const prompt =
    `Candidate profile (JSON):\n${JSON.stringify(profileForPrompt(record))}\n\n` +
    (jobText ? `Role context:\n${String(jobText).slice(0, 4000)}\n\n` : '') +
    'Return ONLY a JSON object of the shape:\n' +
    '{"groups": [{"area": "short label", "questions": ["question", ...]}, ...]} with 2-4 groups and 2-4 questions each.';
  try {
    const { model, text } = await llm.complete({ system: KIT_SYSTEM, prompt });
    const j = parseJsonLoose(text);
    const groups = j && Array.isArray(j.groups)
      ? j.groups
          .map((g) => ({ area: String((g && g.area) || 'Questions').slice(0, 80), questions: arrOfStr(g && g.questions, 6) }))
          .filter((g) => g.questions.length)
          .slice(0, 5)
      : [];
    if (!groups.length) return { mode: 'live', model, ...fallback, note: 'showing a local draft (could not parse the model output)' };
    return { mode: 'live', model, groups };
  } catch (err) {
    return { mode: 'fallback', model: null, ...fallback, ai_error: err.message };
  }
}

// ---- outreach draft -------------------------------------------------------

const OUTREACH_SYSTEM =
  'You help a recruiter write a short, warm, personalized first-contact message to a candidate. ' +
  'Reference specifics from their real background; keep it concise (3-5 sentences), genuine, and free of hype or invented praise. ' +
  'End with a low-pressure ask for a short chat. Leave the sender name as {{your name}}.';

function outreachFallback(record, { jobTitle } = {}) {
  const name = firstName(record.full_name) || 'there';
  const skill = topSkillNames(record, 1)[0];
  const subject = jobTitle ? `${name}, a ${jobTitle} role that fits your background` : `${name}, a quick note`;
  const body =
    `Hi ${name},\n\n` +
    `I came across your profile${record.headline ? ` (${record.headline})` : ''}` +
    `${skill ? ` and your work with ${skill}` : ''}, and I think there could be a strong fit` +
    `${jobTitle ? ` for a ${jobTitle} role` : ''} on our team. Would you be open to a short chat this week?\n\n` +
    'Best,\n{{your name}}';
  return { subject, body };
}

async function outreach(record, { jobText, jobTitle, tone } = {}) {
  const fallback = outreachFallback(record, { jobTitle });
  if (llm.mode() !== 'live') return { mode: llm.mode(), model: null, ...fallback };

  const prompt =
    `Candidate profile (JSON):\n${JSON.stringify(profileForPrompt(record))}\n\n` +
    (jobTitle ? `Role title: ${jobTitle}\n` : '') +
    (jobText ? `Role context:\n${String(jobText).slice(0, 3000)}\n\n` : '') +
    (tone ? `Tone: ${String(tone).slice(0, 40)}\n` : '') +
    'Return ONLY a JSON object of the shape:\n{"subject": "email subject line", "body": "the message"}';
  try {
    const { model, text } = await llm.complete({ system: OUTREACH_SYSTEM, prompt });
    const j = parseJsonLoose(text);
    if (!j || typeof j.body !== 'string' || !j.body.trim()) {
      return { mode: 'live', model, ...fallback, note: 'showing a local draft (could not parse the model output)' };
    }
    return { mode: 'live', model, subject: String(j.subject || fallback.subject).trim(), body: j.body.trim() };
  } catch (err) {
    return { mode: 'fallback', model: null, ...fallback, ai_error: err.message };
  }
}

// ---- natural-language search ---------------------------------------------
//
// The model turns the query into a structured filter; the deterministic engine
// does the ranking. So results stay explainable: each is scored by the same
// scoreCandidate the JD matcher uses, plus keyword/location components, and
// every point is spelled out in `why`.

const SEARCH_SYSTEM =
  'You convert a technical recruiter\'s natural-language candidate search into a structured filter. ' +
  'Only extract constraints the query actually states — do not invent skills, seniority, or locations. ' +
  'Map skill mentions to the provided canonical skill names when one clearly matches (e.g. "js" -> "JavaScript").';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'who', 'has', 'have', 'had', 'are', 'was', 'were', 'that', 'this', 'from', 'into', 'about',
  'someone', 'somebody', 'people', 'person', 'candidate', 'candidates', 'find', 'show', 'need', 'want', 'looking', 'good',
  'great', 'strong', 'experience', 'experienced', 'years', 'year', 'plus', 'over', 'more', 'than', 'least', 'worked', 'work',
  'can', 'able', 'any', 'all', 'our', 'their', 'them', 'they', 'a', 'an', 'in', 'on', 'of', 'to', 'or', 'at', 'by', 'is',
]);

function keywordsOf(query, taken) {
  const skip = new Set(taken.map((t) => t.toLowerCase()));
  const words = String(query).toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) || [];
  const out = [];
  for (const w of words) {
    if (STOPWORDS.has(w) || skip.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

// Deterministic query understanding: reuse the JD requirement extractor for
// skills / years / role words, and pull remaining significant words as keywords.
function parseQueryFallback(query) {
  const req = extractRequirements(query);
  const skills = req.skills || [];
  const roleWords = req.titleWords || [];
  return {
    skills,
    minYears: req.minYears,
    roleWords,
    location: null,
    keywords: keywordsOf(query, [...skills, ...roleWords]),
  };
}

async function parseQuery(query) {
  if (llm.mode() !== 'live') return { parsed: parseQueryFallback(query), by: llm.mode() };

  const canon = Object.keys(CANON).slice(0, 200).join(', ');
  const prompt =
    `Known canonical skills: ${canon}\n\n` +
    `Recruiter query: "${String(query).slice(0, 500)}"\n\n` +
    'Return ONLY a JSON object of the shape:\n' +
    '{"skills": ["canonical or literal skill", ...], "minYears": number-or-null, "roleWords": ["engineer","backend",...], ' +
    '"location": "city or country or null", "keywords": ["free-text term", ...]}';
  try {
    const { model, text } = await llm.complete({ system: SEARCH_SYSTEM, prompt });
    const j = parseJsonLoose(text);
    if (!j) return { parsed: parseQueryFallback(query), by: 'fallback' };
    const minYears = Number.isFinite(j.minYears) ? Math.max(0, Math.round(j.minYears)) : null;
    return {
      parsed: {
        skills: arrOfStr(j.skills, 12),
        minYears,
        roleWords: arrOfStr(j.roleWords, 8).map((w) => w.toLowerCase()),
        location: j.location && String(j.location).trim() ? String(j.location).trim() : null,
        keywords: arrOfStr(j.keywords, 8).map((w) => w.toLowerCase()),
      },
      by: 'live',
      model,
    };
  } catch (err) {
    return { parsed: parseQueryFallback(query), by: 'fallback', ai_error: err.message };
  }
}

function haystack(record) {
  return [
    record.full_name, record.headline,
    ...(record.skills || []).map((s) => s.name),
    ...(record.experience || []).flatMap((e) => [e.title, e.company, e.summary]),
    ...(record.projects || []).flatMap((p) => [p.name, ...(p.tech || [])]),
    record.location ? `${record.location.city || ''} ${record.location.country || ''}` : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

function round2(x) { return Math.round(x * 100) / 100; }

// Rank the pool against a parsed query. Reuses scoreCandidate (the audited JD
// scorer) for skills/years/role, then folds in keyword and location signals —
// every contributing part is returned in `why`.
function rankByQuery(parsed, candidates, limit) {
  const requirements = { skills: parsed.skills, required: parsed.skills, niceToHave: [], minYears: parsed.minYears, titleWords: parsed.roleWords };
  const loc = parsed.location ? parsed.location.toLowerCase() : null;

  const scored = candidates.map((c) => {
    const record = c.record;
    const base = scoreCandidate(record, requirements);

    const num = [];
    const why = [];
    if (base.parts.length) {
      num.push([base.score, 0.7]);
      for (const p of base.parts) why.push(p.detail);
    }
    if (parsed.keywords.length) {
      const hay = haystack(record);
      const hits = parsed.keywords.filter((k) => hay.includes(k));
      num.push([hits.length / parsed.keywords.length, 0.2]);
      if (hits.length) why.push(`keywords: ${hits.join(', ')}`);
    }
    if (loc) {
      const here = record.location ? `${record.location.city || ''} ${record.location.country || ''}`.toLowerCase() : '';
      const match = here.includes(loc) ? 1 : 0;
      num.push([match, 0.1]);
      if (match) why.push(`location: ${parsed.location}`);
    }
    const den = num.reduce((s, [, w]) => s + w, 0);
    const relevance = den ? round2(num.reduce((s, [v, w]) => s + v * w, 0) / den) : 0;

    return {
      candidate_id: c.candidate_id,
      full_name: record.full_name,
      headline: record.headline,
      overall_confidence: record.overall_confidence,
      relevance,
      why,
      matched: base.matched,
      missing: base.missing,
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance || String(a.candidate_id).localeCompare(b.candidate_id));
  return scored.slice(0, limit);
}

async function search(query, candidates, { limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    const e = new Error('a search query is required');
    e.status = 400;
    throw e;
  }
  const { parsed, by, model, ai_error } = await parseQuery(q);
  const results = rankByQuery(parsed, candidates, limit);
  return { mode: by, model: model || null, query: q, parsed, count: results.length, results, ...(ai_error ? { ai_error } : {}) };
}

module.exports = { FEATURES, summarize, interviewKit, outreach, search, mode: llm.mode };
