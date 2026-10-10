/* AgriKalkunahon-AI server: a Cloudflare Worker between the app and the AI model.
   Required Notice: Copyright 2026 Jef Zerrudo (https://github.com/jbzerrudo/AgriKalkunahon-AI)
   Licensed under the PolyForm Noncommercial License 1.0.0
   https://polyformproject.org/licenses/noncommercial/1.0.0

   The model is Qwen3.8-27B (Qwen team, Alibaba Cloud; Apache License 2.0), run by Cloudflare Workers AI.
   No key is kept here: the model is reached through the Workers AI binding named AI (wrangler.jsonc).

   It does four things for the app, and nothing else:
     route   reads a farmer's question and says which AgriKalkunahon calculation answers it, which words
             in the question hold each value, and which words to search for. It returns words, not
             numbers: the app reads the numbers from those words by fixed rules, and only if the words
             are really in the question.
     advise  writes advice from a calculation the app has already made, using only that calculation.
     search  looks the question up in Wikipedia and in open-access journal articles (through OpenAlex)
             and returns what it finds, with the links. No AI is used for this.
     answer  answers a question no calculation covers, using only the texts the app sends: AgriKalkunahon's
             own explanations, limits and sources, and what the search found. It says NO_SOURCE when
             none of them relates to the question.
   The rules the AI must follow are fixed here, so no page can replace them. Requests are accepted only
   from the app's own site, with limits on size, and a light limit per address. The real limit is the
   free daily allowance of Workers AI: when it is used up the app is told so, and nothing is charged. */

const MODEL = '@cf/qwen/qwen3.8-27b';
const SITE = 'https://jbzerrudo.github.io';
const MAX = { question: 600, cards: 9000, material: 20000, query: 200 };
/* Thinking is switched off: the answers are short, and thinking would use up the free allowance. */
const QUIET = { reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: false } };
/* At most this many requests from one address in ten minutes, counted in each running copy of the Worker.
   It only slows down one person or script hammering the server; it is not an exact limit. The app's
   self-test sends 61 questions in a row, so the figure is above that. */
const PER_ADDRESS = 70, WINDOW_MS = 10 * 60 * 1000;

const ROUTE_RULES = [
  "You read a farmer's question and decide which of the app's calculations answers it. Each calculation is listed with its id, what it decides, and the boxes it needs.",
  'Reply with one JSON object and nothing else, in this form:',
  '{"card": "<id of the calculation, or none>", "quotes": {"<box id>": "<words copied from the question>"}, "search": "<search words>"}',
  'Rules:',
  '1. Choose the calculation that decides what the farmer is asking about. If none of them does, give "none".',
  '2. For each box whose value the question states, copy the words of the question that state it, with the number and its unit, for example "32 degrees", "85%" or "June 1". Copy them exactly. Never convert, round, add up or work out a value, and never guess one.',
  '3. Leave out every box the question does not state. An empty "quotes" is normal.',
  '4. The question may be in Filipino, English, another Philippine language, or a mix of them.',
  '5. In "search", give the few English words someone would type to look the question up in an encyclopedia or a library of farm science, followed by any Filipino farm terms in the question, for example "frost temperature Benguet andap". No full sentence.'
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
  'You are the AI in AgriKalkunahon-AI, a farm-weather advice app for the Philippines. A farmer asked QUESTION, and none of the app\'s calculations answers it by itself.',
  'MATERIAL holds texts that may be relevant, each starting with its id in square brackets. Ids that start with a calculation name, or with app:, why:, unv: or ref:, are AgriKalkunahon\'s own published texts: its explanations, assumptions, limits and references, with the sources they cite. Ids that start with wiki: are from Wikipedia, and paper: from open-access journal articles, found by a search for this question and not checked by AgriKalkunahon.',
  'Rules:',
  '1. Use only MATERIAL. Do not answer from your own knowledge, and do not add any number, date, threshold, practice or claim that is not in MATERIAL.',
  '2. Prefer AgriKalkunahon\'s own texts. Use Wikipedia or a paper for what those texts do not cover, and say in the sentence where it comes from, for example "Wikipedia says" or "a 2019 study from Japan found".',
  '3. Keep figures and citations exactly as MATERIAL gives them, for example "1.5 to 3.9 °C (Basquial et al. 2021)".',
  '4. If MATERIAL answers only part of the question, say what it does say, then say plainly what it does not, and why if MATERIAL says why (a short record, a method calibrated elsewhere, a value that could not be verified).',
  '5. If a study or article is about another country, crop or season, say so. If two texts disagree, say so; do not choose between them silently.',
  '6. Say which of the app\'s calculations, by its title, would help the farmer further, and what the farmer would need for it.',
  '7. If MATERIAL names who sets the official guidance (PAGASA, DA, PhilRice, BPI, the product label), say to follow them.',
  '8. Only if nothing in MATERIAL relates to the question, reply with exactly NO_SOURCE and nothing else.',
  '9. Otherwise begin your reply with a line USED: followed by the ids of the texts you relied on, separated by commas. Then a blank line. Then the answer, at most eight sentences.',
  ...COMMON.map((x, i) => (i + 10) + '. ' + x)
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

/* ---------- search ---------- */
/* Wikimedia asks every program that reads its API to say what it is and where to find it. */
const UA = 'AgriKalkunahon-AI/0.3 (https://jbzerrudo.github.io/AgriKalkunahon-AI/)';
async function getJSON(url, headers) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(headers || {}) }, signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
const clip = (v, n) => { const s = String(v || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' …' : s; };
/* The opening section of the three best-matching English Wikipedia articles. */
async function wikipedia(query) {
  const j = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1'
    + '&generator=search&gsrnamespace=0&gsrlimit=3&prop=extracts%7Cinfo&exintro=1&explaintext=1&exlimit=3&inprop=url'
    + '&gsrsearch=' + encodeURIComponent(query), { 'Api-User-Agent': UA });
  const pages = (j && j.query && Array.isArray(j.query.pages)) ? j.query.pages : [];
  return pages.filter(p => p && p.title && p.extract).sort((a, b) => (a.index || 0) - (b.index || 0)).slice(0, 3)
    .map((p, i) => ({ id: 'wiki:' + (i + 1), source: 'Wikipedia', title: p.title,
      url: p.fullurl || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_'))), text: clip(p.extract, 1500) }));
}
/* OpenAlex keeps each abstract as an index of words and their places; this puts the words back in order. */
function abstractOf(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, places] of Object.entries(inv)) if (Array.isArray(places)) for (const k of places) if (k >= 0 && k < 5000) words[k] = w;
  return words.filter(Boolean).join(' ');
}
/* The three best-matching open-access journal articles that have an abstract. OpenAlex answers without a
   key on a small daily budget; with a free key, set as the secret OPENALEX_KEY, the budget is larger. */
async function openalex(query, env) {
  const j = await getJSON('https://api.openalex.org/works?per_page=3&search=' + encodeURIComponent(query)
    + '&filter=' + encodeURIComponent('open_access.is_oa:true,has_abstract:true')
    + (env && env.OPENALEX_KEY ? '&api_key=' + encodeURIComponent(env.OPENALEX_KEY) : ''));
  const works = (j && Array.isArray(j.results)) ? j.results : [];
  return works.map((w, i) => {
    const names = (w.authorships || []).map(a => a && a.author && a.author.display_name).filter(Boolean);
    const venue = w.primary_location && w.primary_location.source && w.primary_location.source.display_name;
    return { id: 'paper:' + (i + 1), source: 'OpenAlex', title: clip(w.display_name || w.title, 300),
      authors: names.length > 2 ? names[0] + ' et al.' : names.join(' and '), year: w.publication_year || null, venue: venue || '',
      url: (w.open_access && w.open_access.oa_url) || w.doi || w.id || '', text: clip(abstractOf(w.abstract_inverted_index), 1500) };
  }).filter(x => x.title && x.text);
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
      if (body.task === 'search') {
        const query = text(body.query, MAX.query) || question.slice(0, MAX.query);
        const [wiki, papers] = await Promise.all([wikipedia(query), openalex(query, env)]);
        return json({ results: wiki.concat(papers) });
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
