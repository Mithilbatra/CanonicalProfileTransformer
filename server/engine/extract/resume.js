'use strict';

const { obs, subject } = require('./_common');
const { CANON, canonicalizeSkill } = require('../skills');

// Resume extractor. Works on plain text — PDF/DOCX files are converted to
// text first (see server/lib/filetext.js) so this stays pure and testable.
//
// Resumes are the least predictable structured source, so everything here is
// a heuristic: we look for a name at the top, contact details anywhere, and
// then split the document into sections (EXPERIENCE / EDUCATION / SKILLS /
// CERTIFICATIONS / ACTIVITIES / COURSEWORK) by their headings. Anything we
// cannot confidently read is simply skipped — same principle as the rest of
// the engine: never guess.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s|,;)>\]]+/gi;
// "Mar 2021 - Present", "03/2021 – 06/2023", "2019 - 2022"
const DATE_RANGE_RE = /((?:[A-Za-z]{3,9}\.?\s+)?\d{4}|\d{1,2}\/\d{4})\s*[-–—to]+\s*((?:[A-Za-z]{3,9}\.?\s+)?\d{4}|\d{1,2}\/\d{4}|present|current|now)/i;
const DEGREE_RE = /\b(b\.?\s?tech|m\.?\s?tech|b\.?s\.?c?|m\.?s\.?c?|b\.?e\.?|m\.?e\.?|ph\.?d|bachelor[’']?s?|master[’']?s?|mba|bca|mca|diploma|board)\b/i;
const INSTITUTION_RE = /\b(university|college|institute|institution|school|academy|iit|nit|iiit)\b/i;
const BULLET_RE = /^[•▪◦●‣*-]\s*/;

const SECTION_HEADINGS = {
  experience: /^(work\s+)?(experience|employment(\s+history)?|professional\s+experience|work\s+history|internships?)\s*:?$/i,
  education: /^(education|academics|academic\s+background|qualifications)\s*:?$/i,
  skills: /^((technical\s+)?skills|technologies|tech\s+stack|core\s+competencies)\s*:?$/i,
  certifications: /^((licenses?\s*&?\s*)?certifications?(\s*&\s*achievements?)?|certificates?|courses?\s*&?\s*certifications?)\s*:?$/i,
  activities: /^(extra[-\s]?curricular(\s+activities)?|activities|achievements?|awards?(\s*&?\s*achievements?)?|honors?|leadership)\s*:?$/i,
  coursework: /^((relevant\s+)?coursework|relevant\s+courses)\s*:?$/i,
  projects: /^((personal|academic|key)\s+)?projects?\s*:?$/i,
  other: /^(publications?|languages?|interests?|hobbies|summary|objective|about(\s+me)?)\s*:?$/i,
};

function extractResume(raw, sourceId = 'resume', opts = {}) {
  const text = preprocess(raw);
  if (!text.trim()) {
    return { sourceId, sourceType: 'resume', ok: false, error: 'empty source', subjects: [] };
  }

  const lines = coalesceBullets(text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()));
  const observations = [];

  extractContact(text, observations);
  extractAnnotationLinks(opts.links, observations);
  extractHeader(lines, observations);

  const sections = splitSections(lines);
  extractSkills(sections.skills, text, observations);
  extractExperience(sections.experience, observations);
  extractEducation(sections.education, observations);
  extractProjects(sections.projects, observations);
  extractCertifications(sections.certifications, observations);
  extractActivities(sections.activities, observations);
  extractCoursework(sections.coursework, observations);

  const yoe = text.toLowerCase().match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:experience|exp)/);
  if (yoe) observations.push(obs('years_experience', yoe[1], 'resume:years_regex'));

  return {
    sourceId,
    sourceType: 'resume',
    ok: true,
    error: null,
    subjects: observations.length ? [subject(sourceId, 'resume', observations)] : [],
  };
}

// PDFs frequently glue the caption of the *next* clickable item onto an
// email's TLD: "gmail.comLinkedIn", "satyam@x.comGitHub". A TLD is lowercase
// by convention, so a lowercase->uppercase seam right after the final dot
// segment is glue — cut it there. (The real link targets are recovered
// separately from PDF annotations; this just keeps the text-scanned copy clean.)
function cleanGluedEmail(raw) {
  return String(raw).replace(/(\.[a-z]{2,})([A-Z][A-Za-z]*)$/, '$1');
}

// Month/year date that trails a value, with or without a glued boundary:
// "PostgreSQLJanuary 2025", "Assembly January 2025", "DOM Manipulation Dec 2024".
const MONTH_SRC = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
function stripTrailingDate(s) {
  return String(s)
    .replace(new RegExp(`\\s*${MONTH_SRC}\\.?\\s*(?:19|20)?\\d{2}\\s*$`, 'i'), '')
    .replace(/\s*\b(?:19|20)\d{2}\s*$/, '')
    .trim();
}

// Some PDFs place the bullet glyph on its own line, with the bullet's text on
// the following line. Left as-is, those text lines look like new entries (a
// project header, say). Re-attach a lone bullet to the next non-empty line so
// every section parser sees one bullet per item.
function coalesceBullets(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[•▪◦●‣]$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      if (j < lines.length) {
        out.push('• ' + lines[j]);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
}

// PDF text extraction produces predictable damage; repair it before parsing:
//  - words hyphen-wrapped across lines ("Ar-\ntificial" -> "Artificial")
//  - columns glued together without a space ("Delhi2023", "InternJune 2026")
//  - combining accents detached from their letter ("L'Or ́eal" -> "L'Oréal")
function preprocess(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\s*([̀-ͯ])\s*([a-zA-Z])/g, '$2$1')
    .normalize('NFC')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/([a-z)])((?:19|20)\d{2})\b/g, '$1 $2')
    .replace(/([a-z])((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2})/g, '$1 $2');
}

function extractContact(text, observations) {
  const emails = new Set((text.match(EMAIL_RE) || []).map(cleanGluedEmail));
  emails.forEach((e) => observations.push(obs('email', e, 'resume:email_regex')));

  for (const p of text.match(PHONE_RE) || []) {
    // skip digit runs that are actually date ranges like "2019 - 2022"
    if (/^\d{4}\s*[-–]\s*\d{4}$/.test(p.trim())) continue;
    if (p.replace(/\D/g, '').length >= 9) {
      observations.push(obs('phone', p, 'resume:phone_regex'));
      break; // first plausible phone only; later digit runs are usually noise
    }
  }

  const seen = new Set();
  for (const u of text.match(URL_RE) || []) {
    const clean = u.replace(/[.,;:]+$/, '');
    if (!seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      observations.push(obs('link', clean, 'resume:url_regex'));
    }
  }
}

// Hyperlink annotations recovered from the PDF itself (see lib/filetext.js).
// These are the URLs behind clickable words like "GitHub" — they never show
// up in the extracted text, yet they are the strongest identity signals a
// resume carries (profile links are strong merge keys).
function extractAnnotationLinks(links, observations) {
  if (!Array.isArray(links)) return;
  for (const raw of links) {
    const uri = String(raw).trim();
    if (/^mailto:/i.test(uri)) {
      observations.push(obs('email', uri.replace(/^mailto:/i, '').split('?')[0], 'resume:pdf_annotation'));
    } else if (/^https?:\/\//i.test(uri)) {
      observations.push(obs('link', uri, 'resume:pdf_annotation'));
    }
  }
}

// The name is almost always the first short line without contact noise; a
// title-like line under it becomes the headline; a "City, ST" line near the
// top becomes the location. Only the lines ABOVE the first section heading
// count — anything below belongs to a section (a "B.Tech in ... Engineering"
// education line must not be mistaken for a job headline).
function extractHeader(lines, observations) {
  const firstHeading = lines.findIndex((l) =>
    Object.values(SECTION_HEADINGS).some((re) => re.test(l)));
  const headerEnd = firstHeading === -1 ? 8 : Math.min(firstHeading, 8);
  const top = lines.slice(0, headerEnd).filter(Boolean);

  const nameLine = top.find(
    (l) =>
      l.length <= 40 &&
      !/[@\d/]/.test(l) &&
      /^[A-Z][a-zA-Z'.-]+(\s+[A-Z][a-zA-Z'.-]+){1,3}$/.test(l)
  );
  if (nameLine) {
    // ALL-CAPS letterhead names read better title-cased
    const name = nameLine === nameLine.toUpperCase() ? titleCaseName(nameLine) : nameLine;
    observations.push(obs('full_name', name, 'resume:top_line'));
  }

  const TITLE_WORDS = /(engineer|developer|designer|manager|analyst|scientist|architect|consultant|lead|intern|specialist|administrator)/i;
  const headline = top.find(
    (l) => l !== nameLine && l.length <= 90 && !/[@]/.test(l) && TITLE_WORDS.test(l) && !DEGREE_RE.test(l)
  );
  if (headline) observations.push(obs('headline', headline, 'resume:title_line'));

  const location = top.find(
    (l) => l !== nameLine && l !== headline && /^[A-Z][a-zA-Z\s.]+,\s*[A-Za-z\s.]+$/.test(l) && l.length <= 50 && !TITLE_WORDS.test(l)
  );
  if (location) observations.push(obs('location', location, 'resume:top_location'));
}

function titleCaseName(s) {
  return s.toLowerCase().replace(/(^|[\s'.-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// Splits the resume into named sections using its headings.
function splitSections(lines) {
  const sections = { experience: [], education: [], skills: [], certifications: [], activities: [], coursework: [], projects: [] };
  let current = null;
  for (const line of lines) {
    const heading = Object.keys(SECTION_HEADINGS).find((k) => SECTION_HEADINGS[k].test(line));
    if (heading) {
      current = heading === 'other' ? null : heading;
      continue;
    }
    if (current && line) sections[current].push(line);
  }
  return sections;
}

// Words that appear in prose but never in a skill name. If a candidate
// "skill" contains one, the line was a sentence, not a list — skip it.
const PROSE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'by',
  'from', 'is', 'are', 'was', 'be', 'has', 'have', 'that', 'this', 'it', 'its',
  'at', 'as', 'if', 'when', 'only', 'since', 'not', 'no', 'never',
]);

// Category labels that precede a skills list ("Programming: Java, ...").
const CATEGORY_LABELS = /(programming|languages?|databases?|tools?|frameworks?|practices|areas?|cloud|core|web|backend|frontend|devops|libraries|platforms|skills|technologies|ui\/ux|others?|concepts?)$/i;

function looksLikeSkill(s) {
  const words = s.split(/\s+/);
  if (words.length > 4) return false;
  if (words.some((w) => PROSE_WORDS.has(w.toLowerCase()))) return false;
  return true;
}

// In two-column PDFs the category label glues onto the first skill of its
// row: "ProgrammingJava", "Cloud & ToolsAzure", "UI/UXReact". Try every
// camel-case boundary; prefer a split whose right side is a known skill,
// else accept one whose left side is a known category label.
function stripCategoryLabel(item) {
  if (canonicalizeSkill(item)?.known) return item;
  let labelSplit = null;
  for (let i = 1; i < item.length - 1; i++) {
    const lowerUpper = /[a-z]/.test(item[i - 1]) && /[A-Z]/.test(item[i]);
    const upperRunEnd = /[A-Z]/.test(item[i - 1]) && /[A-Z]/.test(item[i]) && /[a-z]/.test(item[i + 1] || '');
    if (!lowerUpper && !upperRunEnd) continue;
    const left = item.slice(0, i).trim();
    const right = item.slice(i).trim();
    if (canonicalizeSkill(right)?.known) return right;
    if (CATEGORY_LABELS.test(left)) labelSplit = right;
  }
  return labelSplit || item;
}

function extractSkills(skillLines, fullText, observations) {
  const found = new Set();
  const add = (raw, method) => {
    const key = raw.trim().toLowerCase();
    if (key && key.length <= 40 && !found.has(key) && found.size < 50) {
      found.add(key);
      observations.push(obs('skill', raw.trim(), method));
    }
  };

  if (skillLines.length) {
    // A skills section is a list: split on commas, bullets, pipes.
    // "Languages: Python, Go" — drop the category label before the colon.
    // Real skills sections are short; a long tail means the heading match
    // was a false positive, so stop after a few lines.
    for (const line of skillLines.slice(0, 12)) {
      const list = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
      const items = list
        .split(/[,•|;·]+/)
        .map((item) => item.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      items.forEach((s, i) => {
        if (i === 0) s = stripCategoryLabel(s);
        if (s && s.length <= 40 && !/\d{4}/.test(s) && looksLikeSkill(s)) {
          add(s, 'resume:skills_section');
        }
      });
    }
    return;
  }

  // No skills section — fall back to scanning the whole text for known skills.
  const lower = fullText.toLowerCase();
  for (const [canon, aliases] of Object.entries(CANON)) {
    for (const alias of [canon.toLowerCase(), ...aliases]) {
      const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(alias)}(?:$|[^a-z0-9+#.])`, 'i');
      if (re.test(lower)) {
        add(canon, 'resume:skill_scan');
        break;
      }
    }
  }
}

// Experience lines come in a few common shapes:
//   "Senior Engineer — Acme Corp    Mar 2021 - Present"
//   "Acme Corp | Senior Engineer | 2019 - 2022"
//   "HSBC : Software Engineering Intern    June 2026 – Present"
//   "Senior Engineer at Acme Corp (2019 - 2022)"
// A line with a date range starts a new entry; following lines without
// one are treated as its description.
function extractExperience(expLines, observations) {
  let entry = null;
  const flush = () => {
    if (entry && (entry.company || entry.title)) {
      observations.push(obs('experience_entry', entry, 'resume:experience_section'));
    }
    entry = null;
  };

  for (const line of expLines) {
    const range = line.match(DATE_RANGE_RE);
    if (range) {
      flush();
      const head = line.replace(DATE_RANGE_RE, '').replace(/[()|,–—:-]+\s*$/, '').trim();
      const { title, company } = splitTitleCompany(head);
      entry = { company, title, start: range[1], end: range[2], summary: null };
    } else if (entry && line && !/^[-•*]?\s*$/.test(line)) {
      const clean = deglueProse(line.replace(BULLET_RE, ''));
      const summary = entry.summary ? `${entry.summary} ${clean}` : clean;
      entry.summary = summary.slice(0, 400);
    }
  }
  flush();
}

const ROLE_WORDS = /(engineer|developer|designer|manager|analyst|scientist|architect|consultant|lead|intern)/i;

function splitTitleCompany(head) {
  // try explicit separators first, then "Company : Title", then "Title at Company"
  for (const sep of [' — ', ' – ', ' - ', ' | ', ', ']) {
    if (head.includes(sep)) {
      const [a, b] = head.split(sep).map((s) => s.trim());
      // titles contain role words; companies usually don't
      return ROLE_WORDS.test(a) ? { title: a, company: b } : { title: b, company: a };
    }
  }
  const colon = head.match(/^([^:]{2,60})\s*:\s*(.{2,80})$/);
  if (colon) {
    const [a, b] = [colon[1].trim(), colon[2].trim()];
    return ROLE_WORDS.test(a) ? { title: a, company: b } : { title: b, company: a };
  }
  const at = head.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) return { title: at[1].trim(), company: at[2].trim() };
  return { title: head || null, company: null };
}

// Education comes in two shapes:
//   one line:  "B.Tech in Computer Science, NIT Delhi, 2018"
//   two lines: "National Institute of Technology, Delhi   2023 – Present"
//              "B.Tech. in Computer Science and Engineering   CGPA: 8.93"
// An institution-only line opens a pending entry; the degree line right
// after it completes the pair. Grades (CGPA/percentage) are dropped.
function extractEducation(eduLines, observations) {
  const entries = [];
  let pending = null;
  const push = (e) => { if (e && (e.institution || e.degree)) entries.push(e); };

  for (let raw of eduLines) {
    const line = raw
      .replace(BULLET_RE, '')
      .replace(/(?:cgpa|gpa|percentage|score)\s*:?\s*[\d.]+\s*%?\s*$/i, '')
      .trim();
    if (!line) continue;

    const range = line.match(/((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present|current)/i);
    const endYear = range ? (/present|current/i.test(range[2]) ? null : range[2]) : (line.match(/\b(19|20)\d{2}\b(?!.*\b(19|20)\d{2}\b)/) || [null])[0];
    const body = line.replace(/((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present|current)/i, '').replace(/[,;|–—-]+\s*$/, '').trim();

    const hasDegree = DEGREE_RE.test(body);
    const hasInstitution = INSTITUTION_RE.test(body);

    if (hasInstitution && !hasDegree) {
      push(pending);
      pending = { institution: body, degree: null, field: null, end_year: endYear };
    } else if (hasDegree) {
      const fieldMatch = body.match(/\b(?:in|of)\s+([A-Z][A-Za-z&\s]+?)(?:\s*[,|(–—]|\s+-\s|$)/);
      const field = fieldMatch ? fieldMatch[1].trim() : null;
      const degree = field ? body.slice(0, body.indexOf(fieldMatch[0])).replace(/\s+$/, '') || body : null;
      if (pending && !pending.degree) {
        // completes the institution line above it
        pending.degree = clampStr(degree || body, 80);
        pending.field = field;
        if (endYear) pending.end_year = pending.end_year || endYear;
        push(pending);
        pending = null;
      } else {
        // self-contained line; institution is the comma part that names one
        const parts = body.split(/[,|–—]|\s-\s/).map((s) => s.trim()).filter(Boolean);
        const institution = parts.find((p) => INSTITUTION_RE.test(p)) || null;
        push({ institution, degree: clampStr(degree || body, 80), field, end_year: endYear });
      }
    }
  }
  push(pending);

  for (const e of entries) {
    observations.push(obs('education_entry', e, 'resume:education_section'));
  }
}

// Projects look like:
//   "Resolvr – Incident Management App | Next.js, PostgreSQL, Node.js"
//   "• Built a full-stack web application ..."
// A non-bullet line starts a new project; the part after "|" is its tech
// list, the bullets under it are its summary. The tech list is also emitted
// as skill observations — same reasoning as GitHub repo languages: it's
// direct evidence the candidate works with those tools.
function extractProjects(lines, observations) {
  const projects = [];
  let current = null;
  const flush = () => { if (current && current.name) projects.push(current); current = null; };
  const addSummary = (raw) => {
    if (!current) return;
    const clean = deglueProse(raw.replace(BULLET_RE, ''))
      // drop a trailing hyperlink caption glued after the sentence ("...resolution.Github")
      .replace(/([.!?])\s*(github|gitlab|link|demo|live)\s*$/i, '$1');
    current.summary = clampStr(current.summary ? `${current.summary} ${clean}` : clean, 400);
  };

  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      addSummary(line);
    } else if (!looksLikeProjectHeader(line)) {
      // a bullet's text wrapped onto another line — belongs to the current
      // project's summary, not a new project
      addSummary(line);
    } else {
      flush();
      const [head, ...tail] = line.split('|');
      // the header often ends with the project's date ("… PostgreSQLJanuary 2025");
      // strip it from both the name and the last technology so it never becomes a skill
      const name = clampStr(stripTrailingDate(head.replace(DATE_RANGE_RE, '')).replace(/[|,–—:-]+\s*$/, ''), 120);
      const technologies = tail
        .join('|')
        .split(/[,;·]+/)
        .map((t) => stripTrailingDate(t.replace(/\s+/g, ' ').trim()))
        .filter((t) => t && t.length <= 40 && looksLikeSkill(t));
      current = { name, technologies, summary: null };
      technologies.forEach((t) => observations.push(obs('skill', t, 'resume:project_tech')));
    }
  }
  flush();
  for (const p of projects) observations.push(obs('project_entry', p, 'resume:projects_section'));
}

// A project header is either "Name | tech, tech" or a short title line —
// never a wrapped fragment of a bullet's prose (which starts lowercase, ends
// in a period, or runs long like a sentence).
function looksLikeProjectHeader(line) {
  if (!line) return false;
  if (line.includes('|')) return true;
  if (!/^[A-Z0-9]/.test(line)) return false;
  if (/[.,;]$/.test(line)) return false;
  return line.split(/\s+/).length <= 8;
}

// "• Cassandra (Udemy) – Gained expertise in ..." -> {name, issuer, summary}
function extractCertifications(lines, observations) {
  for (const text of groupBullets(lines)) {
    const m = text.match(/^(.+?)\s*\(([^)]+)\)\s*[–—:-]?\s*(.*)$/);
    const entry = m
      ? { name: clampStr(m[1], 80), issuer: clampStr(m[2], 60), summary: m[3] ? clampStr(m[3], 250) : null }
      : { name: clampStr(text.split(/\s+[–—-]\s+/)[0], 80), issuer: null, summary: null };
    if (entry.name) observations.push(obs('certification_entry', entry, 'resume:certifications_section'));
  }
}

// Each bullet is one activity/achievement, kept as a plain line of text.
function extractActivities(lines, observations) {
  for (const text of groupBullets(lines)) {
    const clean = clampStr(text, 200);
    if (clean) observations.push(obs('activity', clean, 'resume:activities_section'));
  }
}

// A comma-separated list of course names.
function extractCoursework(lines, observations) {
  const items = lines
    .join(' ')
    .split(/[,;•|]+/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 80);
  for (const item of items.slice(0, 40)) {
    observations.push(obs('coursework', item, 'resume:coursework_section'));
  }
}

// PDF font changes (bold/italic runs) swallow the space at their boundary,
// gluing prose together: "Secured99.467", "Solved800+problems". Repair the
// letter<->digit seams, token by token. Only prose (bullets, summaries) goes
// through this — never contact lines or skills — and tokens that are emails
// or URLs are left alone, as are short version suffixes (html5, es6, i18n).
function deglueProse(s) {
  return s
    .split(' ')
    .map((tok) => {
      if (tok.includes('@') || /https?:\/\/|www\./i.test(tok)) return tok;
      return tok
        // word glued to a number: "Secured99.467" -> "Secured 99.467"
        // (needs 2+ digits ending the run, so html5 / es6 stay intact)
        .replace(/([a-z])(\d{2,}(?:[.,]\d+)*)(?=$|[^a-z0-9])/gi, '$1 $2')
        // number glued to a word: "800+problems" -> "800+ problems"
        // (needs a 3+ letter word, so i18n / k8s stay intact)
        .replace(/(\d\+?)([a-z]{3,})/gi, '$1 $2');
    })
    .join(' ');
}

// Bulleted sections wrap long items across lines; a bullet starts a new
// item, anything else continues the current one.
function groupBullets(lines) {
  const items = [];
  let current = null;
  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      if (current) items.push(current);
      current = line.replace(BULLET_RE, '');
    } else if (current) {
      current += ' ' + line;
    } else {
      current = line; // section without bullets: each line is an item
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items.map(deglueProse);
}

function clampStr(s, n) {
  if (s == null) return null;
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, n) : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { extractResume };
