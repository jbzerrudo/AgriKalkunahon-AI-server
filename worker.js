/* AgriKalkunahon-AI server: a Cloudflare Worker between the app and the AI model.
   Required Notice: Copyright 2026 Jef Zerrudo (https://github.com/jbzerrudo/AgriKalkunahon-AI)
   Licensed under the PolyForm Noncommercial License 1.0.0
   https://polyformproject.org/licenses/noncommercial/1.0.0

   The model is Qwen3.8-27B (Qwen team, Alibaba Cloud; Apache License 2.0), run by Cloudflare Workers AI.
   No key is kept here: the model is reached through the Workers AI binding named AI (wrangler.jsonc).

   It does three things for the app, and nothing else:
     route   reads a farmer's question and says which AgriKalkunahon calculation answers it, and which
             words in the question hold each value. It returns words, not numbers: the app reads the
             numbers from those words by fixed rules, and only if the words are really in the question.
     advise  writes advice from a calculation the app has already made, using only that calculation.
     answer  answers a question no calculation covers, using only the AgriKalkunahon texts the app sends,
             or says NO_SOURCE when they do not cover it.
   The rules the AI must follow are fixed here, so no page can replace them. Requests are accepted only
   from the app's own site, with limits on size, and a light limit per address. The real limit is the
   free daily allowance of Workers AI: when it is used up the app is told so, and nothing is charged. */

const MODEL = '@cf/qwen/qwen3.8-27b';
const SITE = 'https://jbzerrudo.github.io';
const MAX = { question: 600, cards: 9000, material: 16000 };
/* Thinking is switched off: the answers are short, and thinking would use up the free allowance. */
const QUIET = { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } };
/* At most this many requests from one address in ten minutes, counted in each running copy of the Worker.
   It only slows down one person or script hammering the server; it is not an exact limit. The app's
   self-test sends 61 questions in a row, so the figure is above that. */
const PER_ADDRESS = 70, WINDOW_MS = 10 * 60 * 1000;

const ROUTE_RULES = [
  "You read a farmer's question and decide which of the app's calculations answers it. Each calculation is listed with its id, what it decides, and the boxes it needs.",
  'Reply with one JSON object and nothing else, in this form:',
  '{"card": "<id of the calculation, or none>", "quotes": {"<box id>": "<words copied from the question>"}}',
  'Rules:',
  '1. Choose the calculation that decides what the farmer is asking about. If none of them does, give "none".',
  '2. For each box whose value the question states, copy the words of the question that state it, with the number and its unit, for example "32 degrees", "85%" or "June 1". Copy them exactly. Never convert, round, add up or work out a value, and never guess one.',
  '3. Leave out every box the question does not state. An empty "quotes" is normal.',
  '4. The question may be in Filipino, English, another Philippine language, or a mix of them.'
].join('\n');

const COMMON = [
  'Write in the language of the question: Filipino, English, or the same mix of both. If it is in another Philippine language and you cannot write that language well, write in Filipino.',
  'Use short sentences and the plain words a farmer uses. Do not use headings, tables or bold text.',
  'Never name a pesticide, a fertilizer, a brand or a dose, and never give a rate of application.',
  'Do not list sources; the app shows them under your answer.'
];
const ADVISE_RULES = [
  'You are the AI in AgriKalkunahon-AI, a farm-weather advice app for the Philippines. A farmer asked QUESTION. The app has already worked out the answer with published, cited methods; that calculation is RESULT.',
  'Write the advice for the farmer. Rules:',
  '1. Use only what RESULT says. Do not add any number, date, time, product, practice or claim that is not in RESULT. You may say what RESULT says in plainer words and connect it to the question.',
  '2. Start with the direct answer to the question. Then give the main reasons from RESULT. Then, if RESULT says so, what to do next or what to watch. At most six sentences.',
  '3. If RESULT shows that a box was left empty or a value is out of range, say what to fill in, instead of giving advice.',
  '4. If RESULT names who sets the official guidance (PAGASA, DA, PhilRice, the product label), end by saying to follow them where they differ.',
  ...COMMON.map((x, i) => (i + 5) + '. ' + x)
].join('\n');
const ANSWER_RULES = [
  'You are the AI in AgriKalkunahon-AI, a farm-weather advice app for the Philippines. A farmer asked QUESTION, and none of the app\'s calculations answers it. MATERIAL holds the app\'s own texts that may be relevant, each under a heading with its id in square brackets.',
  'Rules:',
  '1. Answer only from MATERIAL. If MATERIAL does not answer the question, reply with exactly NO_SOURCE and nothing else. Do not answer from your own knowledge.',
  '2. Otherwise, begin your reply with a line USED: followed by the ids of the texts you relied on, separated by commas. Then a blank line. Then the answer, at most six sentences.',
  '3. If one of the app\'s calculations would help, say which, by its title.',
  ...COMMON.map((x, i) => (i + 4) + '. ' + x)
].join('\n');

const seen = new Map();
function throttled(request) {
  const who = request.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
  const list = (seen.get(who) || []).filter(t => now - t < WINDOW_MS);
  list.push(now); seen.set(who, list);
  if (seen.size > 5000) seen.clear();
  return list.length > PER_ADDRESS;
}
const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
/* The model's reply in either of the two shapes Workers AI uses, with any thinking removed. */
function replyText(out) {
  let t = '';
  if (out && typeof out.response === 'string') t = out.response;
  else if (out && out.choices && out.choices[0] && out.choices[0].message) t = out.choices[0].message.content || '';
  return String(t).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/* The switches that turn thinking off are taken from the model's documentation. If the service ever
   refuses them as input it does not accept, the request is sent again without them, rather than failing. */
const REFUSED_INPUT = /invalid input|8001|chat_template_kwargs|enable_thinking|reasoning_effort|unrecognized|additional propert/i;
async function run(env, params) {
  try { return await env.AI.run(MODEL, { ...params, ...QUIET }); }
  catch (e) {
    if (!REFUSED_INPUT.test(String((e && e.message) || e))) throw e;
    try { return await env.AI.run(MODEL, { ...params, reasoning_effort: 'low' }); }
    catch (e2) {
      if (!REFUSED_INPUT.test(String((e2 && e2.message) || e2))) throw e2;
      return env.AI.run(MODEL, params);
    }
  }
}

export default {
  async fetch(request, env) {
    const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (request.headers.get('Origin') !== SITE) return json({ error: 'origin' }, 403);
    if (throttled(request)) return json({ error: 'slow_down' }, 429);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
    const question = text(body && body.question, MAX.question);
    if (!question) return json({ error: 'bad_request' }, 400);
    try {
      if (body.task === 'route') {
        const cards = text(body.cards, MAX.cards);
        if (!cards) return json({ error: 'bad_request' }, 400);
        const out = await run(env, { messages: [
          { role: 'system', content: ROUTE_RULES },
          { role: 'user', content: 'Calculations:\n' + cards + '\n\nQuestion: ' + question }
        ], max_completion_tokens: 400, temperature: 0 });
        return json({ text: replyText(out), usage: (out && out.usage) || null });
      }
      if (body.task === 'advise' || body.task === 'answer') {
        const material = text(body.material, MAX.material);
        if (!material) return json({ error: 'bad_request' }, 400);
        const advise = body.task === 'advise';
        const stream = await run(env, { messages: [
          { role: 'system', content: advise ? ADVISE_RULES : ANSWER_RULES },
          { role: 'user', content: (advise ? 'RESULT:\n' : 'MATERIAL:\n') + material + '\n\nQUESTION: ' + question }
        ], max_completion_tokens: 900, temperature: 0.2, stream: true });
        return new Response(stream, { headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
      }
      return json({ error: 'bad_request' }, 400);
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/3036|daily free allocation/i.test(m)) return json({ error: 'daily_limit' }, 429);
      if (/3040|capacity temporarily exceeded/i.test(m)) return json({ error: 'busy' }, 503);
      return json({ error: 'model', detail: m.slice(0, 300) }, 502);
    }
  }
};
