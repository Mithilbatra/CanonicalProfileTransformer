# Canonical Profile Transformer

Turns messy, conflicting candidate data from many sources into **one trustworthy
canonical profile per candidate** — normalized, deduplicated across sources, with
**provenance** (where each value came from) and **per-field confidence**.

Guiding rule from the brief: **wrong-but-confident is worse than honestly-empty.**
The engine never invents values; an unknown stays `null`.

---

## What it does

- Ingests **structured** sources (recruiter CSV, ATS JSON with foreign field names)
  and **unstructured** sources (**PDF/DOCX resumes**, GitHub profile + repo languages,
  LinkedIn profile, free-text recruiter notes).
- Detects each source type, extracts a uniform **observation** stream, normalizes
  every value (phones → E.164, dates → `YYYY-MM`, countries → ISO-3166 alpha-2,
  skills → canonical names), then **resolves entities** and **merges** into one record.
- Assigns confidence from **source reliability × field affinity**, raised when
  multiple sources **agree**.
- Projects the immutable canonical record through a **runtime config** that can
  select/rename/normalize fields and toggle provenance & confidence — **no code changes**.
- **Validates** both the canonical record and the projected output before returning it.
- **Degrades gracefully**: a missing or malformed source is reported and skipped, the run continues.

Beyond the one-shot pipeline, the app also runs as a **persistent candidate database**:

- **Uploads accumulate** — a resume uploaded today merges (via SQLite-stored raw
  observations) with a CSV row ingested last week, not just within its own batch.
- **Fuzzy name matching** — spelling drift ("Jordan Rivera" / "Jordn Rivera") merges
  when a company or city corroborates; conflicting emails/phones always block it, and
  a name alone still never merges two people.
- **Manual overrides** — a recruiter can correct any core field in the UI; the value
  wins with confidence 1.0, is recorded in provenance as `human · manual_override:<who>`,
  and survives future uploads and re-merges. Overrides can be reset to the merged value.
- **Auth & organizations** — the database routes require an account (scrypt password
  hashes, revocable bearer tokens). Registering starts a new **organization**; every
  candidate, subject, override, view and audit row is scoped to it, so two orgs are
  fully isolated and never merge — even when they hold the same person. Admins invite
  teammates with a **role** (admin / recruiter / viewer; viewers are read-only). The
  stateless playground stays open.
- **Bias-blind matching** — rank candidates against a JD with identity (name, location,
  links) hidden behind a stable alias, so screening happens on merit; identity never
  feeds the score, and reviewers reveal it per-candidate only after assessing fit.
- **Skill ontology** — a required skill can be covered by a more specific one (React
  covers a JavaScript requirement) at a discount, with the stand-in surfaced ("via
  React"). Explainable, deterministic — no embeddings.
- **Audit log** — every upload, edit, delete, export and match is recorded (who, what,
  when) and visible to admins, org-scoped.
- **CSV / XLSX / JSON export** of the (optionally filtered) candidate database, plus
  **saved views** (named search+skill filter combinations).
- **Hardened live fetch** — GitHub calls get timeouts, retry with backoff, a TTL cache
  and request spacing; set `GITHUB_TOKEN` to raise the API rate limit.
- **PDF hyperlink recovery** — the URLs behind clickable words ("LinkedIn", "GitHub")
  are read from the PDF's own link annotations, no extra dependency.
- **Link enrichment** — a discovered GitHub profile link is fetched live (opt-in) and
  merged as an additional source, corroborating skills and raising confidence.
  LinkedIn links are recorded but never scraped (no public API).
- **Incremental merge** — subjects are indexed by identity keys (`subject_keys`), so an
  upload only re-resolves the candidates it can possibly touch, not the whole database.
- **JD matching** — paste a job description; candidates are ranked with an explainable
  score (skills × confidence, years fit, role-word overlap — every component itemized).
- **Improvement suggestions** — per candidate, what's missing and what fixing it is
  worth in confidence terms, derived from the actual scoring formula.
- **OCR** — photographed resumes (PNG/JPG) are read via tesseract.js (first use
  downloads the English model into `data/ocr-cache`). Scanned image-only PDFs are
  rejected with a clear message to upload as an image instead.

---

## Quick start

Requires Node 18+ (developed on Node 22). From the repo root:

```bash
npm install
npm test          
```

### CLI (the primary surface)

```bash
# default canonical schema
npm run cli -- --in samples/recruiter.csv samples/ats.json samples/github.json \
  samples/recruiter_notes.txt samples/broken.json \
  --config configs/default.json

# custom config, write to a file
npm run cli -- --in samples/recruiter.csv samples/ats.json samples/github.json \
  samples/recruiter_notes.txt \
  --config configs/custom.example.json --out out.json

# point "--in" at a whole folder instead of listing files
npm run cli -- --in samples2/ --config configs/default.json
```

CLI flags: `--in <files...>` `--config <file>` `--out <file>` `--network` (allow live
GitHub fetch) `--quiet` (JSON only, suppress the source report on stderr).

The JSON profiles go to stdout (or `--out`); the **source report** and any validation
errors go to stderr, so piping stays clean.

### Minimal UI (optional)

Two terminals:

```bash
# terminal 1 — engine API on :4000
npm start

# terminal 2 — UI dev server on :5173 
cd web && npm install && npm run dev
```

Open http://localhost:5173. Pick which sources to feed, choose **default** or
**recruiter_shortlist**, toggle confidence/provenance, and run. Each field shows its
confidence meter and source trail; `view raw json` shows the schema-valid output.

To serve the built UI from the API itself: `cd web && npm run build`, then `npm start`
and open http://localhost:4000.

---

## Command reference

Every command you might need, grouped by task. Run from the repo root unless noted.

### Setup & tests

```bash
node -v                       # requires Node 18+ (developed on Node 22)
npm install                   # install engine/CLI/server deps
npm test                      # 17 tests (normalization + pipeline + edge cases)
node --test test/*.test.js    # same, run directly
```

### CLI

```bash
# default canonical schema
node server/cli.js --in samples --config configs/default.json

# custom config
node server/cli.js --in samples --config configs/custom.example.json

# second candidate set (adds a LinkedIn source: +91 phones, IN country)
node server/cli.js --in samples2 --config configs/default.json

# list individual files instead of a folder
node server/cli.js \
  --in samples/recruiter.csv samples/ats.json samples/github.json \
       samples/recruiter_notes.txt samples/broken.json \
  --config configs/default.json

# write JSON to a file instead of stdout
node server/cli.js --in samples --config configs/default.json --out out.json

# JSON only
node server/cli.js --in samples --config configs/default.json --quiet

# allow a live GitHub API fetch for a github URL/handle source
node server/cli.js --in samples --config configs/default.json --network

# help
node server/cli.js --help
```

Via the npm script (note: `npm run cli` prints an npm banner to stdout — call
`node server/cli.js` directly when you want clean, pipeable JSON):

```bash
npm run cli -- --in samples --config configs/default.json
```

`on_missing` (`null` / `omit` / `error`) is set **inside the config file**, not via a
flag. Both shipped configs use `"null"`; copy a config and change that field to try the
other modes (`error` halts with a non-zero exit code).

### Determinism check

```bash
# same inputs -> byte-identical output (the two hashes match)
node server/cli.js --in samples --config configs/default.json --quiet | shasum
node server/cli.js --in samples --config configs/default.json --quiet | shasum
```

### HTTP API

```bash
npm start                                 
curl -s localhost:4000/api/health         # health check
curl -s localhost:4000/api/samples        

# transform sources via POST 
curl -s localhost:4000/api/transform \
  -H 'Content-Type: application/json' \
  -d '{"sources":[{"name":"ats.json","content":"{\"candidateName\":\"Jordan Rivera\",\"emailAddress\":\"jordan@example.com\",\"phoneNumber\":\"+14155550132\",\"skillSet\":[\"Python\",\"kubernetes\"]}"}]}'
```

### Candidate database API (auth required)

```bash
# create an account / sign in — both return { token }
curl -s -X POST localhost:4000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"atleast8chars"}'
TOKEN=...   # from the response

# upload source files (pdf, docx, csv, json, txt) — merges into stored candidates
curl -s -X POST localhost:4000/api/upload -H "Authorization: Bearer $TOKEN" \
  -F 'files=@samples/recruiter.csv' -F 'files=@some_resume.pdf'

# browse / search / filter
curl -s "localhost:4000/api/candidates?q=jordan" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:4000/api/candidates?skill=python" -H "Authorization: Bearer $TOKEN"

# correct a field by hand (allowed: full_name, headline, years_experience, emails, phones, location)
curl -s -X PATCH localhost:4000/api/candidates/<id> -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"field":"headline","value":"Staff Engineer"}'

# undo a manual correction / delete a candidate (and its raw source data)
curl -s -X DELETE localhost:4000/api/candidates/<id>/overrides/headline -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE localhost:4000/api/candidates/<id> -H "Authorization: Bearer $TOKEN"

# export the database (same q/skill filters apply): csv, xlsx, or json
curl -s localhost:4000/api/export.csv  -H "Authorization: Bearer $TOKEN" -o candidates.csv
curl -s localhost:4000/api/export.xlsx -H "Authorization: Bearer $TOKEN" -o candidates.xlsx
curl -s localhost:4000/api/export.json -H "Authorization: Bearer $TOKEN" -o candidates.json

# rank candidates against a job description (explainable score per candidate);
# add "blind":true to redact identity from the results (bias-blind screening)
curl -s -X POST localhost:4000/api/match -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"jd":"Senior Backend Engineer, 4+ years, Python, PostgreSQL, Kubernetes","blind":true}'

# organization: invite a teammate, list members, read the audit log (admin only)
curl -s -X POST localhost:4000/api/org/members -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"email":"teammate@co.com","password":"atleast8chars","role":"recruiter"}'
curl -s localhost:4000/api/org/members -H "Authorization: Bearer $TOKEN"
curl -s localhost:4000/api/audit -H "Authorization: Bearer $TOKEN"

# per-candidate improvement suggestions
curl -s localhost:4000/api/candidates/<id>/suggestions -H "Authorization: Bearer $TOKEN"

# saved views (named filter combinations)
curl -s -X POST localhost:4000/api/views -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"python devs","skill":"python"}'
curl -s localhost:4000/api/views -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE localhost:4000/api/views/<id> -H "Authorization: Bearer $TOKEN"

# upload with GitHub link enrichment (fetches discovered profile links live)
curl -s -X POST localhost:4000/api/upload -H "Authorization: Bearer $TOKEN" \
  -F 'files=@resume.pdf' -F 'allowNetwork=true'
```

The database lives in `data/app.db` (SQLite, created on first run, gitignored).
Set `DB_PATH` to relocate it.

### Web UI

```bash
# dev mode
npm start                                 # terminal 1 — API on :4000
cd web && npm install && npm run dev      # terminal 2 — UI on :5173 
# open - http://localhost:5173

# production build
cd web && npm install && npm run build    # outputs web/dist
cd .. && npm start                        # open http://localhost:4000
```

### Reproduce the committed outputs

```bash
node server/cli.js --in samples  --config configs/default.json        --out output/default.output.json            2>  output/run-report.txt
node server/cli.js --in samples  --config configs/custom.example.json --out output/recruiter_shortlist.output.json 2>> output/run-report.txt
node server/cli.js --in samples2 --config configs/default.json        --out output/candidate2.default.output.json            2>  output/candidate2.run-report.txt
node server/cli.js --in samples2 --config configs/custom.example.json --out output/candidate2.recruiter_shortlist.output.json 2>> output/candidate2.run-report.txt
```

### Optional: install as a global command

```bash
npm link                                 
profile-transform --in samples --config configs/default.json
```

---

## Sample data & produced output

`samples/` contains one realistic, deliberately conflicting scenario:

| file | group | what's tricky |
|------|-------|---------------|
| `recruiter.csv` | structured | header drift (`E-mail`, `Phone Number`); a **second, different** person (Casey Tan) |
| `ats.json` | structured | foreign field names; different name spelling (`Jordan A. Rivera`); `"Present"` end date |
| `github.json` | unstructured | **no email**; links to the same person only via the GitHub profile URL |
| `recruiter_notes.txt` | unstructured | free text; lowest-trust source; adds `React` (single-source) |
| `broken.json` | — | malformed JSON, to prove graceful degradation |

The committed output of a full run is in `output/`:
`default.output.json`, `recruiter_shortlist.output.json`, and `run-report.txt`.

Things that show up in that output and are worth looking at:

- **Entity resolution** — 2 profiles. GitHub (which has no email/phone) merges into
  Jordan purely via the shared `github.com/jrivera-dev` profile link. Casey is kept
  separate because the contact keys differ — names alone never merge people.
- **Agreement raises confidence** — `Python` ≈ 0.93 (seen in ATS + GitHub + notes),
  while `React` is low (notes only).
- **Normalization** — `(415) 555-0132` → `+14155550132`; `USA` → `US`;
  `March 2021` → `2021-03`; `Present` → `null`.
- **Honestly empty** — Casey's unknown fields are `null`, not guessed.

---

## The configurable-output twist

The canonical record is built once and never mutated. A **projection layer**
(`server/engine/project.js`) reads it through a config and assembles a fresh output.
See `configs/custom.example.json`:

```json
{
  "name": "recruiter_shortlist",
  "fields": [
    { "path": "full_name", "type": "string", "required": true },
    { "path": "primary_email", "from": "emails[0]", "type": "string", "required": true },
    { "path": "phone", "from": "phones[0]", "type": "string", "normalize": "E164" },
    { "path": "country", "from": "location.country", "type": "string" },
    { "path": "headline", "type": "string" },
    { "path": "skills", "from": "skills[].name", "type": "string[]", "normalize": "canonical" },
    { "path": "github", "from": "links.github", "type": "string" }
  ],
  "include_confidence": true,
  "include_provenance": false,
  "on_missing": "null"
}
```

Supported per config: field **selection**, **rename + remap** via `from`
(`emails[0]`, `location.country`, `skills[].name` fan-out), per-field **normalize**
(`E164`, `canonical`, `lowercase`, `uppercase`), declared **type** + validation,
toggles for **confidence/provenance**, and **on_missing** = `null` | `omit` | `error`.

---

## Architecture

```
detect → extract (per source) → normalize → merge (resolve + pick winner)
       → confidence → project (config) → validate
```

- `engine/detect.js` — type per source (explicit, else sniff by name/content).
- `engine/extract/*` — one extractor per source type. Each emits the same
  **observation** IR (`{field, value, method}` grouped into subjects), so every
  source sits on equal, auditable footing.
- `engine/normalize.js` — pure value cleaners; each returns a clean value **or null**, never a guess.
- `engine/skills.js` — canonical skill names + alias map; unknown skills are kept but flagged.
- `engine/merge.js` — **union-find** entity resolution (strong keys: email / phone /
  profile link; weak key: name + company; name alone never unifies), then winner
  selection by weight with deterministic tie-breaks.
- `engine/confidence.js` — `source reliability × field affinity`, boosted by agreement.
- `engine/project.js` — the projection layer (the twist).
- `engine/validate.js` — schema checks for the canonical record and the projection.
- `engine/pipeline.js` — orchestration with per-source isolation.

**Determinism:** lists are sorted with stable tie-breaks and `candidate_id` is a hash
of the strongest identity signal, so the same inputs always produce byte-identical output
(there's a test for this).

---

## Assumptions

- Phone numbers without a country code are assumed US (configurable default in `normalize.js`).
- `github.json` is a **pre-fetched** API blob so the demo runs fully offline and
  deterministically; pass `--network` (CLI) or toggle *allow network* (UI) to fetch a
  live handle instead.
- Skill canonicalization uses a curated alias map; unrecognized skills are title-cased,
  kept, and flagged `known: false` (confidence dampened, never dropped).
- "Scale on thousands of candidates": entity resolution is keyed and near-linear in
  practice; this build keeps everything in memory, which is fine at that size.

## Deliberately descoped

- ML-based matching (embeddings, learned rankers) — the fuzzy layer is deterministic
  Jaro-Winkler with explainable corroboration rules instead.
- Batching/streaming for very large inputs; the store rebuilds the full merge on each
  ingest, which is simple, deterministic, and fine for tens of thousands of subjects.
- Multi-tenancy — every account shares one candidate pool per deployment.

## Tests

`npm test` runs four suites (30 tests):

- `test/normalize.test.js` — value normalization, skill canonicalization, link classification.
- `test/pipeline.test.js` — entity resolution, link-only merge, agreement-driven confidence,
  end-to-end normalization, schema validity for both configs, graceful degradation on
  garbage, empty input, all three `on_missing` modes, determinism.
- `test/resume.test.js` — resume extraction (name/contact/sections), detection, Jaro-Winkler
  and name similarity, fuzzy merge with corroboration, fuzzy refusal on conflicting emails.
- `test/store.test.js` — cross-upload dedup against stored subjects, search/filter,
  override lifecycle (win → survive rebuild → reset), delete without resurrection,
  auth register/login/logout.
