'use strict';

// Model API client for the AI assist layer. Like lib/mailer.js, it runs for real
// when configured and falls back cleanly otherwise, so every AI flow is
// exercisable without an API key:
//
//   • ANTHROPIC_API_KEY set          -> 'live'  (calls the model API)
//   • AI_MOCK=1, or non-production   -> 'mock'  (deterministic local drafts)
//   • production with no key         -> 'off'   (AI endpoints report 503)
//
// The outputs are drafts for a human to verify — nothing here is ever written
// back into the trusted deterministic candidate record. Set AI_MODEL to pin a
// model; the default tracks a current model id.

const MODEL = process.env.AI_MODEL || 'claude-opus-5';
const isProd = process.env.NODE_ENV === 'production';

function mode() {
  if (process.env.ANTHROPIC_API_KEY) return 'live';
  if (process.env.AI_MOCK === '1' || !isProd) return 'mock';
  return 'off';
}

let _client = null;
function getClient() {
  if (_client) return _client;
  let SDK;
  try {
    SDK = require('@anthropic-ai/sdk');
  } catch {
    const e = new Error('AI features need the @anthropic-ai/sdk package (run: npm install @anthropic-ai/sdk)');
    e.status = 503;
    throw e;
  }
  _client = new SDK(); // resolves ANTHROPIC_API_KEY from the environment
  return _client;
}

// One short, bounded generation. Returns the model's text; callers that want
// JSON parse it defensively and fall back to a deterministic local draft, so an
// endpoint never hard-fails on the AI path. Low effort keeps these small tasks
// fast and cheap — they're strong at it on current models.
async function complete({ system, prompt, maxTokens = 4096 }) {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' },
  });
  if (resp.stop_reason === 'refusal') {
    const e = new Error('the model declined to generate this');
    e.status = 422;
    throw e;
  }
  return {
    model: resp.model,
    text: resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim(),
  };
}

module.exports = { mode, MODEL, complete };
