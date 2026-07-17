'use strict';

// Improvement suggestions for a candidate profile: what is missing, why it
// matters, and roughly what fixing it is worth. Rule-based on purpose —
// every suggestion is grounded in how the confidence model actually works,
// so "estimated_gain" is real arithmetic, not vibes:
//
//   overall = 0.6 * mean(field confidences) + 0.4 * completeness
//   completeness = present core fields / 7
//
// so one missing core field costs about 0.4/7 ≈ 0.06 of overall confidence,
// and corroborating a single-source field raises its field confidence via
// the agreement boost.

const CORE_GAIN = 0.06; // ≈ 0.4 * (1/7), the completeness value of one core field

function suggestImprovements(record, fieldConf = {}) {
  const suggestions = [];
  const add = (field, severity, message, gain = null) =>
    suggestions.push({ field, severity, message, estimated_gain: gain });

  // -- contact & identity (these also drive entity resolution) --
  if (!record.emails.length) {
    add('emails', 'high', 'No email found. An email is the strongest identity signal — without it, data from other sources may not merge into this profile.', CORE_GAIN);
  }
  if (!record.phones.length) {
    add('phones', 'high', 'No phone number found. Add one in a standard format (e.g. +91 98765 43210); it is both a contact channel and a merge key.', CORE_GAIN);
  }
  if (!record.links.github) {
    add('links', 'medium', 'No GitHub link. A public GitHub profile independently corroborates programming skills, which raises their confidence through source agreement.');
  }
  if (!record.links.linkedin) {
    add('links', 'medium', 'No LinkedIn link. It strengthens identity matching across sources.');
  }

  // -- core completeness fields --
  if (!record.headline) {
    add('headline', 'medium', 'No professional headline. Put a title line under the name (e.g. "Backend Engineer — Distributed Systems"); recruiters and the completeness score both read it.', CORE_GAIN);
  }
  if (!record.location) {
    add('location', 'medium', 'No location found. Add "City, Country" near the top of the resume.', CORE_GAIN);
  }
  if (!record.experience.length) {
    add('experience', 'high', 'No work experience entries were extracted. Use a clear EXPERIENCE section with "Title — Company   Month Year – Month Year" lines.', CORE_GAIN);
  }
  if (!record.skills.length) {
    add('skills', 'high', 'No skills were extracted. Add a SKILLS section listing technologies separated by commas.', CORE_GAIN);
  }

  // -- confidence quality (fields present but weakly supported) --
  if (record.years_experience == null) {
    add('years_experience', 'low', 'Years of experience are not stated. A phrase like "4+ years of experience" makes it explicit instead of leaving it null.');
  }
  const singleSource = record.skills.filter((s) => s.sources.length === 1);
  if (record.skills.length && singleSource.length >= Math.max(3, record.skills.length / 2)) {
    add(
      'skills',
      'medium',
      `${singleSource.length} of ${record.skills.length} skills rest on a single source. Corroboration (e.g. a linked GitHub profile with matching repository languages) raises their confidence via the agreement boost.`
    );
  }

  // -- structure of existing entries --
  const undated = record.experience.filter((e) => !e.start);
  if (undated.length) {
    add('experience', 'low', `${undated.length} experience ${undated.length === 1 ? 'entry has' : 'entries have'} no start date. Use "Month Year – Month Year" so dates normalize cleanly.`);
  }
  const yearlessEdu = record.education.filter((e) => !e.end_year);
  if (record.education.length && yearlessEdu.length === record.education.length) {
    add('education', 'low', 'No education entry carries a (graduation) year. Add years so timelines can be ordered.');
  }
  if (!record.projects.length) {
    add('projects', 'low', 'No projects listed. A PROJECTS section with "Name | tech, tech" headers adds skill evidence and substance.');
  }
  if (!record.certifications.length) {
    add('certifications', 'low', 'No certifications listed. If any exist, a CERTIFICATIONS section with "Name (Issuer)" lines gets extracted automatically.');
  }

  const order = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => order[a.severity] - order[b.severity] || a.field.localeCompare(b.field));
  return suggestions;
}

module.exports = { suggestImprovements };
