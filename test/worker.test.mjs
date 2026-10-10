/* Tests of worker.js with a stand-in for Workers AI. Run: node test/worker.test.mjs */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const W = (await import('data:text/javascript,' + encodeURIComponent(src))).default;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const SITE = 'https://jbzerrudo.github.io';
let calls = [], behaviour = null, ip = 0;
const env = { AI: { run: async (model, params) => { calls.push({ model, params }); return behaviour(model, params); } } };
const req = (method, body, origin, who) => new Request('https://agrikalkunahon-ai.example.workers.dev/', {
  method, headers: { 'Content-Type': 'application/json', ...(origin === null ? {} : { Origin: origin || SITE }), 'CF-Connecting-IP': who || ('10.0.0.' + (++ip)) },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
const sse = chunks => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(x) + '\n\n')); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });

let r = await W.fetch(req('OPTIONS'), env);
ok('preflight 204', r.status === 204);
ok('preflight allows the site only', r.headers.get('Access-Control-Allow-Origin') === SITE);
r = await W.fetch(req('GET'), env);
ok('GET refused', r.status === 405);
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }, 'https://evil.example'), env);
ok('other site refused', r.status === 403);
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }, null), env);
ok('no Origin refused', r.status === 403);
r = await W.fetch(req('POST', '{not json'), env);
ok('bad JSON refused', r.status === 400);
r = await W.fetch(req('POST', { task: 'route', question: 'x'.repeat(601), cards: 'c' }), env);
ok('question too long refused', r.status === 400);
r = await W.fetch(req('POST', { task: 'teach', question: 'q', cards: 'c' }), env);
ok('unknown task refused', r.status === 400);
ok('no model call for refused requests', calls.length === 0, calls.length);

behaviour = () => ({ response: '<think>hmm</think>{"card":"spray","quotes":{"sT":"32 degrees"}}', usage: { prompt_tokens: 900, completion_tokens: 20 } });
r = await W.fetch(req('POST', { task: 'route', question: 'Spray? 32 degrees', cards: 'spray: Is it safe to spray now?' }), env);
let j = await r.json();
ok('route 200', r.status === 200, r.status);
ok('route text, thinking removed', j.text === '{"card":"spray","quotes":{"sT":"32 degrees"}}', j.text);
ok('route usage passed on', j.usage && j.usage.prompt_tokens === 900);
let c = calls[calls.length - 1];
ok('route model', c.model === '@cf/qwen/qwen3.8-27b', c.model);
ok('route temperature 0', c.params.temperature === 0);
ok('route thinking off', c.params.reasoning_effort === 'low' && c.params.chat_template_kwargs.enable_thinking === false);
ok('route rules are the server\'s', /Copy them exactly/.test(c.params.messages[0].content) && c.params.messages[0].role === 'system');
ok('route rules ask for search words', /"search": "<search words>"/.test(c.params.messages[0].content) && /look the question up in an encyclopedia/.test(c.params.messages[0].content));
ok('route question last', /Question: Spray\? 32 degrees$/.test(c.params.messages[1].content));
ok('route not streamed', !c.params.stream);
behaviour = () => ({ choices: [{ message: { content: '{"card":"none","quotes":{}}' } }] });
r = await W.fetch(req('POST', { task: 'route', question: 'Presyo ng urea?', cards: 'x' }), env);
j = await r.json();
ok('route, OpenAI-style reply', j.text === '{"card":"none","quotes":{}}', j.text);

behaviour = (m, p) => sse([{ choices: [{ delta: { content: 'Huwag ' } }] }, { choices: [{ delta: { content: 'munang mag-spray.' } }] }]);
r = await W.fetch(req('POST', { task: 'advise', question: 'Spray?', material: 'Calculation: spray\nAnswer: Do not spray now.' }), env);
ok('advise streams', r.status === 200 && r.headers.get('Content-Type') === 'text/event-stream');
ok('advise CORS', r.headers.get('Access-Control-Allow-Origin') === SITE);
const body = await r.text();
ok('advise stream passed through', body.includes('munang mag-spray') && body.includes('[DONE]'));
c = calls[calls.length - 1];
ok('advise rules', /Use only what RESULT says/.test(c.params.messages[0].content));
ok('advise rules forbid doses', /Never name a pesticide, a fertilizer, a brand or a dose/.test(c.params.messages[0].content));
ok('advise material first', c.params.messages[1].content.startsWith('RESULT:\nCalculation: spray'));
ok('advise streamed and quiet', c.params.stream === true && c.params.chat_template_kwargs.enable_thinking === false);
r = await W.fetch(req('POST', { task: 'advise', question: 'Spray?' }), env);
ok('advise without material refused', r.status === 400);
r = await W.fetch(req('POST', { task: 'answer', question: 'Ano ang AWD?', material: '[rice] Rice field: re-flood now?\n...' }), env);
await r.text();
c = calls[calls.length - 1];
ok('answer rules', /reply with exactly NO_SOURCE/.test(c.params.messages[0].content) && /USED:/.test(c.params.messages[0].content));
ok('answer material first', c.params.messages[1].content.startsWith('MATERIAL:\n[rice]'));
ok('rules numbered in order', /\n13\. Do not list sources/.test(c.params.messages[0].content), c.params.messages[0].content.slice(-200));
ok('answer rules: partial answers, limits, sources named', /say what it does say, then say plainly what it does not/.test(c.params.messages[0].content) && /say in the sentence where it comes from/.test(c.params.messages[0].content) && /Keep figures and citations exactly/.test(c.params.messages[0].content));

/* search: Wikipedia and OpenAlex, with a stand-in for the network */
const realFetch = globalThis.fetch;
let fetched = [], netMode = 'ok';
globalThis.fetch = async (url, opts) => {
  fetched.push({ url: String(url), ua: opts && opts.headers && opts.headers['User-Agent'], apiUa: opts && opts.headers && opts.headers['Api-User-Agent'] });
  if (netMode === 'down') throw new Error('network down');
  if (String(url).startsWith('https://en.wikipedia.org/')) return new Response(JSON.stringify({ query: { pages: [
    { title: 'Frost', index: 2, fullurl: 'https://en.wikipedia.org/wiki/Frost', extract: 'Frost is a thin layer of ice on a solid surface.' },
    { title: 'Benguet', index: 1, fullurl: 'https://en.wikipedia.org/wiki/Benguet', extract: 'Benguet is a landlocked province in the Cordillera.' },
    { title: 'Empty', index: 3, fullurl: 'https://en.wikipedia.org/wiki/Empty' } ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (String(url).startsWith('https://api.openalex.org/')) return new Response(JSON.stringify({ results: [
    { display_name: 'Frost occurrence in Benguet', publication_year: 2017, doi: 'https://doi.org/10.1/x',
      authorships: [{ author: { display_name: 'R. Marasigan' } }, { author: { display_name: 'A. B' } }, { author: { display_name: 'C. D' } }],
      primary_location: { source: { display_name: 'Some Journal' } }, open_access: { is_oa: true, oa_url: 'https://example.org/oa.pdf' },
      abstract_inverted_index: { 'Frost': [0], 'occurs': [1], 'in': [2, 5], 'Benguet': [3], 'mostly': [4], 'January.': [6] } },
    { display_name: 'No abstract', publication_year: 2020, abstract_inverted_index: null } ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('nf', { status: 404 });
};
calls = [];
r = await W.fetch(req('POST', { task: 'search', question: 'Ano ang temperatura ng andap sa Benguet?', query: 'frost temperature Benguet andap' }), env);
j = await r.json();
ok('search 200 without the model', r.status === 200 && calls.length === 0, { status: r.status, calls: calls.length });
ok('search: Wikipedia in rank order, empty extracts dropped', j.results.filter(x => x.source === 'Wikipedia').map(x => x.title).join('|') === 'Benguet|Frost', j.results.map(x => x.title));
ok('search: paper abstract rebuilt in order', (j.results.find(x => x.source === 'OpenAlex') || {}).text === 'Frost occurs in Benguet mostly in January.', j.results);
ok('search: paper details', (() => { const x = j.results.find(x => x.source === 'OpenAlex'); return x && x.authors === 'R. Marasigan et al.' && x.year === 2017 && x.venue === 'Some Journal' && x.url === 'https://example.org/oa.pdf' && x.id === 'paper:1'; })(), j.results);
ok('search: paper without abstract dropped', j.results.filter(x => x.source === 'OpenAlex').length === 1);
ok('search: query sent, encoded', fetched.some(f => f.url.includes('gsrsearch=frost%20temperature%20Benguet%20andap')) && fetched.some(f => f.url.includes('search=frost%20temperature%20Benguet%20andap')), fetched.map(f => f.url));
ok('search: open-access filter', fetched.some(f => f.url.includes(encodeURIComponent('open_access.is_oa:true,has_abstract:true'))));
ok('search: program named to Wikimedia', fetched.every(f => /^AgriKalkunahon-AI\/[0-9.]+ \(https:\/\/jbzerrudo\.github\.io\/AgriKalkunahon-AI\/\)$/.test(f.ua || '')) && fetched.some(f => f.apiUa));
ok('search: no key unless set', fetched.every(f => !f.url.includes('api_key=')));
fetched = [];
r = await W.fetch(req('POST', { task: 'search', question: 'Ano ang andap?' }), { ...env, OPENALEX_KEY: 'k3y' });
await r.json();
ok('search: key used when set', fetched.some(f => f.url.includes('api_key=k3y')) && fetched.some(f => f.url.includes('gsrsearch=Ano%20ang%20andap%3F')), fetched.map(f => f.url));
netMode = 'down';
r = await W.fetch(req('POST', { task: 'search', question: 'q', query: 'frost' }), env);
j = await r.json();
ok('search: network down gives an empty list, not an error', r.status === 200 && Array.isArray(j.results) && j.results.length === 0, j);
netMode = 'ok';
r = await W.fetch(req('POST', { task: 'search', question: 'q', query: 'x'.repeat(201) }), env);
j = await r.json();
ok('search: overlong query falls back to the question', r.status === 200 && fetched[fetched.length - 1].url.includes('search=q'), fetched.slice(-2).map(f => f.url));
globalThis.fetch = realFetch;
behaviour = () => { throw new Error('3036: You have used up your daily free allocation of 10,000 neurons, please upgrade'); };
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }), env);
ok('daily allowance used up', r.status === 429 && (await r.json()).error === 'daily_limit');
behaviour = () => { throw new Error('3040: Capacity temporarily exceeded, please try again.'); };
r = await W.fetch(req('POST', { task: 'advise', question: 'q', material: 'm' }), env);
ok('busy', r.status === 503 && (await r.json()).error === 'busy');
behaviour = () => { throw new Error('5007: No such model'); };
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }), env);
j = await r.json();
ok('other model error', r.status === 502 && j.error === 'model' && /5007/.test(j.detail));

let tries = [];
behaviour = (m, p) => { tries.push(Object.keys(p).sort().join(',')); if (p.chat_template_kwargs) throw new Error('8001: Invalid input: chat_template_kwargs'); return { response: '{"card":"none","quotes":{}}' }; };
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }), env);
ok('refused switches: sent again without them', r.status === 200 && tries.length === 2 && !/chat_template_kwargs/.test(tries[1]) && /reasoning_effort/.test(tries[1]), tries);
tries = [];
behaviour = (m, p) => { tries.push(Object.keys(p).sort().join(',')); if (p.chat_template_kwargs || p.reasoning_effort) throw new Error('8001: Invalid input'); return { response: '{}' }; };
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }), env);
ok('refused switches: plain request last', r.status === 200 && tries.length === 3 && !/reasoning_effort/.test(tries[2]), tries);
tries = [];
behaviour = (m, p) => { tries.push(1); throw new Error('3036: You have used up your daily free allocation of 10,000 neurons'); };
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }), env);
ok('allowance used up: not sent again', r.status === 429 && tries.length === 1, tries.length);
behaviour = () => ({ response: '{}' });
let last;
for (let k = 0; k < 71; k++) last = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }, SITE, '192.0.2.7'), env);
ok('71st request in ten minutes from one address is slowed', last.status === 429 && (await last.json()).error === 'slow_down');
r = await W.fetch(req('POST', { task: 'route', question: 'q', cards: 'c' }, SITE, '192.0.2.8'), env);
ok('another address is not slowed', r.status === 200);
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
