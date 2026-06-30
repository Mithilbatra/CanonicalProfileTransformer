'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { runPipeline, DEFAULT_CONFIG } = require('./engine/pipeline');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const CONFIGS = path.join(ROOT, 'configs');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

app.get('/api/samples', (_req, res) => {
  const files = [
    { name: 'recruiter.csv', type: 'csv' },
    { name: 'ats.json', type: 'ats' },
    { name: 'github.json', type: 'github' },
    { name: 'recruiter_notes.txt', type: 'notes' },
    { name: 'broken.json', type: 'ats' },
  ].map((f) => ({ ...f, content: readIf(path.join(SAMPLES, f.name)) || '' }));

  const configs = {
    default: JSON.parse(readIf(path.join(CONFIGS, 'default.json')) || '{}'),
    recruiter_shortlist: JSON.parse(readIf(path.join(CONFIGS, 'custom.example.json')) || '{}'),
  };

  res.json({ sources: files, configs });
});

app.post('/api/transform', async (req, res) => {
  try {
    const { sources, config, allowNetwork } = req.body || {};
    if (!Array.isArray(sources)) {
      return res.status(400).json({ error: 'body.sources must be an array of { name, content, type? }' });
    }
    const cfg = config && Object.keys(config).length ? config : DEFAULT_CONFIG;
    const result = await runPipeline(sources, cfg, { allowNetwork: !!allowNetwork });
    res.json(result);
  } catch (err) {
    if (err && err.code === 'PROJECTION_MISSING_FIELD') {
      return res.status(422).json({ error: err.message, code: err.code, field: err.field });
    }
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .type('text/plain')
      .send('API is up. UI build not found — run `npm run dev` in /web for the interface, or POST /api/transform.'));
}

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`transformer API listening on http://localhost:${PORT}`));
}

module.exports = app;
