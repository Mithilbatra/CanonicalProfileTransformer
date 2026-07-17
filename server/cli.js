#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('./engine/pipeline');
const { bufferToText, isBinaryName } = require('./lib/filetext');

function parseArgs(argv) {
  const args = { in: [], config: null, out: null, network: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.in.push(argv[++i]); }
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--network') args.network = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Canonical Profile Transformer

Usage:
  node server/cli.js --in <files...> [--config <file>] [--out <file>] [--network] [--quiet]

Options:
  --in        One or more input files (csv, json, txt, pdf/docx resume, github blob).
  --config    Output config (default: configs/default.json).
  --out       Write JSON here instead of stdout.
  --network   Allow live GitHub API fetch for github URL sources.
  --quiet     Suppress the source report on stderr.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in.length) { printHelp(); process.exit(1); }

  const inputFiles = [];
  for (const p of args.in) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(p).sort()) {
          const full = path.join(p, f);
          if (fs.statSync(full).isFile()) inputFiles.push(full);
        }
      } else {
        inputFiles.push(p);
      }
    } catch (_) {
      inputFiles.push(p);
    }
  }

  const sources = [];
  for (const file of inputFiles) {
    const name = path.basename(file);
    try {
      if (isBinaryName(name)) {
        // PDF / DOCX / image resumes: convert to plain text before the
        // pipeline; PDFs also yield their hyperlink annotations
        const { text, links } = await bufferToText(fs.readFileSync(file), name);
        sources.push({ name, content: text, links });
      } else {
        sources.push({ name, content: fs.readFileSync(file, 'utf8') });
      }
    } catch (e) {
      sources.push({ name, content: '', _readError: e.message });
    }
  }

  const config = args.config
    ? JSON.parse(fs.readFileSync(args.config, 'utf8'))
    : require('../configs/default.json');

  const { profiles, sources: report } = await runPipeline(sources, config, { allowNetwork: args.network });

  if (!args.quiet) {
    console.error('\nSource report:');
    for (const r of report) {
      console.error(`  ${r.ok ? 'OK ' : 'ERR'} ${r.source} (${r.type}) subjects=${r.subjects}${r.error ? ' :: ' + r.error : ''}`);
    }
    console.error(`\nResolved ${profiles.length} profile(s).`);
    for (const p of profiles) {
      if (!p.canonical_valid) console.error('  canonical validation errors:', p.canonical_errors);
      if (!p.projection_valid) console.error('  projection validation errors:', p.projection_errors);
    }
    console.error('');
  }

  const out = profiles.map((p) => p.output);
  const json = JSON.stringify(out.length === 1 ? out[0] : out, null, 2);

  if (args.out) {
    fs.writeFileSync(args.out, json);
    if (!args.quiet) console.error(`Wrote ${args.out}`);
  } else {
    console.log(json);
  }
}

main().catch((e) => {
  if (e && e.code === 'PROJECTION_MISSING_FIELD') {
    console.error(`projection error: ${e.message}`);
    process.exit(2);
  }
  console.error('fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
