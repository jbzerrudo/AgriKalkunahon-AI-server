/* Tests of the number reader in AgriKalkunahon-AI (index.html, between READER START and READER END).
   Run: node test/reader.test.js [path to index.html]. With no path, the app is looked for beside this
   folder, at ../AgriKalkunahon-AI/index.html. */
const fs = require('fs'), path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', '..', 'AgriKalkunahon-AI', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const a = html.indexOf('/* ---- READER START ---- */'), b = html.indexOf('/* ---- READER END ---- */');
if (a < 0 || b < 0) { console.log('reader markers not found in ' + file); process.exit(1); }
const R = new Function(html.slice(a, b) + '\nreturn READ;')();
const today = new Date(2026, 9, 10);   // 10 October 2026, local time
let pass = 0, fail = 0;
function eq(name, got, want) { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass++; else { fail++; console.log('FAIL', name, '\n   got ', g, '\n   want', w); } }
const s = (c, t) => R.scan(c, t, today);
const p = (k, q) => R.parse(k, q, today);

/* ---- scanning the whole question (no AI) ---- */
eq('spray: degrees and percent', s('spray', 'It is 32 degrees and 85% humidity, can I spray?'), { sT: 32, sRH: 85 });
eq('spray: Filipino with symbol', s('spray', 'Pwede ba mag-spray? 31°C, halumigmig 78'), { sT: 31, sRH: 78 });
eq('spray: no numbers', s('spray', 'Pwede ba akong mag-spray ngayon?'), {});
eq('spray: centimetres are not Celsius', s('spray', 'The weeds are 15 cm tall, spray now?'), {});
eq('spray: two temperatures, not one reading', s('spray', '30 degrees now, 34 degrees later, spray?'), {});
eq('spray: Fahrenheit is refused', s('spray', 'It is 90 °F and 60% humidity'), { sRH: 60 });
eq('dry: full sentence', s('dry', 'Can I dry 20 cavans of palay at 24% moisture? Air is 33 C with 60% humidity.'), { dT: 33, dRH: 60, dCav: 20, dMC: 24 });
eq('dry: target moisture is not the grain moisture', s('dry', 'Can my harvested grain reach 14% moisture today? It is 30 degrees, 70% humidity'), { dT: 30, dRH: 70 });
eq('dry: unmarked percentage is not guessed', s('dry', 'Matutuyo ba ang 500 kg na palay? 32 grado, 65%'), { dT: 32, dW: 500 });
eq('dry: decimal comma', s('dry', 'temperatura 31,5 at halumigmig 70'), { dT: 31.5, dRH: 70 });
eq('dry: thousands separator in kg', s('dry', 'Matutuyo ba ang 1,200 kg na palay?'), { dW: 1200 });
eq('dry: moisture before the number', s('dry', 'Moisture ng palay 23%, humidity 65%, 31 C'), { dT: 31, dRH: 65, dMC: 23 });
eq('dry: label before the next number belongs to it', s('dry', 'humidity is 70% and moisture 22%, 30 degrees'), { dT: 30, dRH: 70, dMC: 22 });
eq('dry: bare palay is not a moisture label', s('dry', 'Matutuyo ba ang palay 23%?'), {});
eq('dry: labels in a list with commas', s('dry', 'Can I dry 20 cavans of palay? 33 C, 60% humidity, 24% moisture'), { dT: 33, dRH: 60, dCav: 20, dMC: 24 });
eq('frost: evening reading', s('frost', 'Mag-aandap ba? 6 degrees at 8 pm, 90% humidity'), { fT: 6, fRH: 90 });
eq('frost: below zero', s('frost', 'It is -1 C now in Atok'), { fT: -1 });
eq('disease: no backtracking into 9', s('disease', 'Evening temp 24, humidity 95%. Will leaves be wet?'), { zT: 24, zRH: 95 });
eq('water: high and low by words', s('water', 'Do I water my tomato today? High 33, low 24 degrees'), { crop: 'tomato', tmax: 33, tmin: 24 });
eq('water: high and low with units', s('water', 'Kamatis: pinakamainit 33°C, pinakamalamig 24°C, diligan ko na ba?'), { crop: 'tomato', tmax: 33, tmin: 24 });
eq('water: two plain numbers, one unit', s('water', 'Should I water my corn? 32 and 23 degrees today.'), { crop: 'maize' });
eq('water: two plain temperatures with units', s('water', 'Should I water my corn? 32 C and 23 C today.'), { crop: 'maize', tmax: 32, tmin: 23 });
eq('water: sweet corn before corn', s('water', 'Sweet corn, 31°C and 22°C'), { crop: 'sweetcorn', tmax: 31, tmin: 22 });
eq('water: one temperature is not a high and a low', s('water', 'It is 34 degrees, water the cabbage?'), { crop: 'cabbage' });
eq('water: high with a non-temperature unit', s('water', 'High 80% humidity, low 24 degrees, tomato'), { crop: 'tomato', tmin: 24 });
eq('stress: rice heat', s('stress', 'Rice at flowering, high 37°C and low 26°C'), { xCrop: 'rice', x0x: 37, x0n: 26 });
eq('stress: low above high is refused', s('stress', 'palay, high 20°C low 30°C'), { xCrop: 'rice' });
eq('harvest: variety and date', s('harvest', 'When can I harvest my NSIC Rc222 sown on June 1?'), { tVar: 'NSIC Rc222 (Tubigan 18)', tSow: '2026-06-01' });
eq('harvest: common name, Filipino date', s('harvest', 'Kailan aanihin ang Tubigan 18 na itinanim noong Hunyo 15?'), { tVar: 'NSIC Rc222 (Tubigan 18)', tSow: '2026-06-15' });
eq('harvest: a future month is last year', s('harvest', 'Rc160 sown December 20'), { tVar: 'NSIC Rc160 (Tubigan 14)', tSow: '2025-12-20' });
eq('harvest: an impossible date', s('harvest', 'Rc160 sown February 30'), { tVar: 'NSIC Rc160 (Tubigan 14)' });
eq('harvest: nothing given', s('harvest', 'When is harvest?'), {});
eq('corn: days counted back', s('corn', 'Anong yugto na ang mais ko pagkatapos ng 50 araw? 32°C at 23°C'), { cPlant: '2026-08-21', cTx: 32, cTn: 23 });
eq('corn: ISO date', s('corn', 'Corn planted 2026-07-01, typical high 31 C low 22 C'), { cPlant: '2026-07-01', cTx: 31, cTn: 22 });
eq('rice is never filled', s('rice', 'tube reading 15 cm below'), {});
eq('blight is never filled', s('blight', 'two days above 90%'), {});
eq('variety: Rc with a space', R.variety('rc 216 po ang tanim ko'), 'NSIC Rc216 (Tubigan 17)');
eq('crop: none', R.crop('Is it too hot today?'), null);
eq('crop: chili is not bell pepper', R.crop('sili ko'), null);
eq('crop: coconut', R.crop('Diligan ko ba ang niyog?'), 'palm');

/* ---- reading one value from the words the AI pointed at ---- */
eq('quote: temperature', p('temp', '32 degrees'), 32);
eq('quote: temperature, no unit', p('temp', '32'), 32);
eq('quote: temperature, two numbers refused', p('temp', '32 to 34 degrees'), null);
eq('quote: temperature, Fahrenheit refused', p('temp', '90 F'.replace('F', '°F')), null);
eq('quote: temperature, out of range', p('temp', '75 degrees'), null);
eq('quote: temperature, minus', p('temp', '-2 C'), -2);
eq('quote: temperature, hyphen is not minus', p('temp', 'high-33'), 33);
eq('quote: percent', p('pct', '85%'), 85);
eq('quote: cavans are not a temperature', p('temp', '20 cavans'), null);
eq('quote: humidity is not a temperature', p('temp', '85%'), null);
eq('quote: degrees are not a percentage', p('pct', '33 C'), null);
eq('quote: humidity without the sign', p('pct', 'humidity 85'), 85);
eq('quote: moisture in kilos refused', p('mc', '24 kg'), null);
eq('quote: percent over 100', p('pct', '120%'), null);
eq('quote: moisture', p('mc', '24% moisture'), 24);
eq('quote: moisture too high', p('mc', '70%'), null);
eq('quote: kg needs the unit', p('kg', '500'), null);
eq('quote: kg', p('kg', '1,200 kg'), 1200);
eq('quote: cavans', p('cav', '20 cavans'), 20);
eq('quote: kaban', p('cav', '15 kaban'), 15);
eq('quote: days', p('days', '5 araw'), 5);
eq('quote: km/h', p('kmh', '12 km/h'), 12);
eq('quote: date, English', p('date', 'June 1'), '2026-06-01');
eq('quote: date, days ago', p('date', '50 araw'), '2026-08-21');
eq('quote: crop', p('crop', 'kamatis'), 'tomato');
eq('quote: variety', p('variety', 'Tubigan 18'), 'NSIC Rc222 (Tubigan 18)');
eq('quote: unknown kind', p('wind', 'malakas'), null);
eq('quote found in question', R.inQuestion('32  Degrees', 'Is it OK? 32 degrees now'), true);
eq('quote not in question', R.inQuestion('33 degrees', 'Is it OK? 32 degrees now'), false);
eq('empty quote', R.inQuestion('  ', 'anything'), false);
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
