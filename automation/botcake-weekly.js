#!/usr/bin/env node
/*
  botcake-weekly.js — недельный цикл миссий: снимок недели во вкладку «Миссии» и сброс прогресса.

  Запуск в GitHub Actions по cron-job.org в понедельник 00:00 America/New_York
  (workflow_dispatch с inputs.task = weekly). Порядок: сначала снимок, потом сброс —
  чтобы цифры прошлой недели не потерялись. Бренды идут по очереди: упал один —
  остальные всё равно считаются, код выхода 1 в конце.

  Кого трогаем: только игроков миссий — у кого есть tag M_STARTED (его ставит первый шаг).
  Массовое чтение поля в API отдаёт значения без PSID, поэтому поля читаем по каждому
  игроку отдельно (их сотни, не тысячи).

  Коллекция v2: c_a…c_f (эмодзи предмета или пусто), c_cnt — сколько РАЗНЫХ обычных,
  ступени 3 / 4 / 5 выдаются при c_cnt 3 / 4 / 5, c_gold — золотой.
  Строка отчёта = неделя × бренд: игроки с шагом, выполнения по 5 миссиям (= сколько раз
  выдан код каждой миссии), коллекция по числу разных 0…5, коды ступеней 3/4/5, золотые,
  новые спешл-бонусы за подписку (прирост tag SUB_BONUS_GOT к прошлой строке ЭТОГО бренда).

  Тексты значений по умолчанию, которые зависят от бренда (строка видео-миссии в карточке,
  хвост строки коллекции), — в конфиге: brands.<alias>.missions = { vline_on, vline_off, next0 }.

  CLI:
    node automation/botcake-weekly.js --brand <alias> --dry            — посчитать и показать, ничего не писать
    node automation/botcake-weekly.js --brand <alias>                  — снимок + сброс
    node automation/botcake-weekly.js --brand <alias> --snapshot-only
    node automation/botcake-weekly.js --brand <alias> --set-view off|on [--dry]
        — неделя без видео-постов: строка видео-миссии в карточке «back next week» (или обратно)
          у всех игроков миссий; новичкам то же решает bot field view_on во flow.
*/
const sheets = require('./sheets');
const bc = require('./botcake');

const TAB = 'Миссии';
const LOG_TAB = 'Лог';
const STARTED_TAG = 'M_STARTED';
const BONUS_TAG = 'SUB_BONUS_GOT';
const ITEMS = ['c_a', 'c_b', 'c_c', 'c_d', 'c_e', 'c_f'];

// значения после сброса; True/False через публичный API — строкой
const BASE_DEFAULTS = {
  w_view: '0', w_pz: '0', w_done: '0',
  w_view_r1: 'false', w_view_r2: 'false', w_view_r3: 'false', w_view_r4: 'false',
  w_pz_p1: 'false', w_pz_p2: 'false', w_pz_p3: 'false', w_pz_p4: 'false', w_pz_p5: 'false', w_pz_p6: 'false', w_pz_p7: 'false',
  s_view: '0/2', s_pz: '0/3', w_pred: '0/1', w_sub: '0/1', w_story: '0/1',
  // пустой слот предмета = zero-width space (пробел даёт дыры в строке коллекции)
  c_a: '​', c_b: '​', c_c: '​', c_d: '​', c_e: '​', c_f: '​', c_gold: ' ', c_last: ' ', c_cnt: '0',
  r_line: ' ', r_drop: ' ', r_all: ' ',
};
function missionsCfg(brand) {
  const m = (bc.loadConfig().brands[brand] || {}).missions;
  if (!m || !m.vline_on || !m.vline_off || !m.next0) throw new Error(`${brand.toUpperCase()}: в конфиге нет missions { vline_on, vline_off, next0 }`);
  return m;
}
const defaultsOf = (brand) => { const m = missionsCfg(brand); return { ...BASE_DEFAULTS, s_vline: m.vline_on, c_next: m.next0 }; };

const GOALS = { w_view: 2, w_pz: 3 };
// API хранит ' ' как null — сравниваем без пробелов и zero-width space
const norm = (x) => String(x ?? '').replace(/​/g, '').trim();
const hasItem = (x) => !['', '⬜'].includes(norm(x));

const HEADER = [
  'Неделя (пн, ET)', 'Бренд', 'Снимок (Kyiv)', 'Игроков с шагом',
  '🎬 Видео — кодов', '🧩 Пазлы — кодов', '🔮 Over/Under — кодов', '📨 Подписка — кодов', '🔍 Story — кодов',
  'Разных 0', 'Разных 1', 'Разных 2', 'Разных 3', 'Разных 4', 'Разных 5',
  '🎰 Ступень 3 — кодов', '🎰 Ступень 4 — кодов', '🎰 Ступень 5 — кодов', '⭐ Золотой — кодов',
  '🎁 Спешл-бонус — кодов (новые подписки)', 'SUB_BONUS_GOT всего', 'Сброшено игроков',
];
const LAST_COL = sheets.indexToCol ? sheets.indexToCol(HEADER.length - 1) : 'V';
const BRAND_COL = 1;
const BONUS_TOTAL_COL = HEADER.indexOf('SUB_BONUS_GOT всего');

const kyiv = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16);
// понедельник недели, которая только что закончилась (по ET)
// запуск в пн 00:00 ET: шаг на день назад (вс) → понедельник той недели
function weekLabel(nowMs) {
  const [y, m, d] = new Date(nowMs - 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' }).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// поля и игроки миссий бренда: { pageId, idByName, players, bonusTotal, states }
async function loadPlayers(brand, needFields) {
  const pageId = bc.pageIdOf(brand);
  const fieldList = await bc.getCustomFields(pageId);
  const idByName = Object.fromEntries(fieldList.map((f) => [f.name, String(f.id)]));
  const nameById = Object.fromEntries(fieldList.map((f) => [String(f.id), f.name]));
  const missing = needFields.filter((n) => !idByName[n]);
  if (missing.length) throw new Error(`${brand.toUpperCase()}: на странице нет полей: ${missing.join(', ')}`);

  const customers = await bc.listCustomers(pageId, { concurrency: 10 });
  const hasTag = (c, t) => (c.tags || []).some((x) => x.name === t);
  const players = customers.filter((c) => hasTag(c, STARTED_TAG));
  const bonusTotal = customers.filter((c) => hasTag(c, BONUS_TAG)).length;
  const states = await pool(players, 8, async (c) => {
    const rows = await bc.getCustomerFields(pageId, c.psid);
    const v = {};
    for (const r of rows) v[nameById[String(r.custom_field_id)]] = r.value;
    return { psid: c.psid, v };
  });
  return { pageId, idByName, customers, players, bonusTotal, states };
}

async function writeFields(pageId, list, data) {
  let failed = 0;
  await pool(list, 5, async (s) => {
    try { await bc.api(pageId, `/customer/${s.psid}/customer_fields`, { method: 'POST', body: { psid: s.psid, data } }); } catch (_) { failed++; }
  });
  return failed;
}

async function run(brand, { dry = false, snapshotOnly = false } = {}) {
  const started = Date.now();
  const DEFAULTS = defaultsOf(brand);
  const { pageId, idByName, customers, players, bonusTotal, states } = await loadPlayers(brand, Object.keys(DEFAULTS));

  const done = (s) => ({
    view: Number(s.v.w_view) >= GOALS.w_view,
    pz: Number(s.v.w_pz) >= GOALS.w_pz,
    pred: norm(s.v.w_pred).startsWith('✅'),
    sub: norm(s.v.w_sub) === '✅',
    story: norm(s.v.w_story) === '✅',
  });
  const active = (s) => Number(s.v.w_view) > 0 || Number(s.v.w_pz) > 0 || Number(s.v.w_done) > 0
    || norm(s.v.w_pred).startsWith('✅') || norm(s.v.w_sub) === '✅' || norm(s.v.w_story) === '✅';
  const coll = [0, 0, 0, 0, 0, 0];
  const tiers = { 3: 0, 4: 0, 5: 0 };
  let view = 0, pz = 0, pred = 0, sub = 0, story = 0, gold = 0, act = 0;
  for (const s of states) {
    const d = done(s);
    view += d.view; pz += d.pz; pred += d.pred; sub += d.sub; story += d.story;
    if (active(s)) act++;
    // c_cnt — источник правды; если пусто (старый игрок) — по самим предметам
    const cnt = Math.min(5, Number(s.v.c_cnt) || ITEMS.filter((k) => hasItem(s.v[k])).length);
    coll[cnt]++;
    for (const t of [3, 4, 5]) if (cnt >= t) tiers[t]++;
    if (hasItem(s.v.c_gold)) gold++;
  }

  sheets.setSpreadsheetId(bc.loadConfig().sheet_id);
  const prevRows = dry ? [] : await sheets.read(`'${TAB}'!A2:${LAST_COL}`).catch(() => []);
  const prevMine = prevRows.filter((r) => String(r[BRAND_COL] || '').toUpperCase() === brand.toUpperCase());
  const prevBonus = prevMine.length ? Number(prevMine[prevMine.length - 1][BONUS_TOTAL_COL] || 0) : bonusTotal;

  const toReset = states.filter((s) => Object.entries(DEFAULTS).some(([n, def]) => norm(s.v[n]) !== norm(def)));
  const row = [weekLabel(Date.now()), brand.toUpperCase(), kyiv(Date.now()), act, view, pz, pred, sub, story, ...coll,
    tiers[3], tiers[4], tiers[5], gold, Math.max(0, bonusTotal - prevBonus), bonusTotal, snapshotOnly ? 0 : toReset.length];

  const summary = { brand: brand.toUpperCase(), players: players.length, active: act, toReset: toReset.length, row };
  if (dry) { console.log('--dry:', JSON.stringify(summary)); return summary; }

  // снимок
  await ensureTab();
  await sheets.append(`'${TAB}'!A:${LAST_COL}`, [row]);

  // сброс
  let failed = 0;
  if (!snapshotOnly) {
    const data = Object.entries(DEFAULTS).map(([n, value]) => ({ id: idByName[n], value }));
    failed = await writeFields(pageId, toReset, data);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const status = failed ? `сброс: ошибок ${failed}` : 'ok';
  await sheets.append(`'${LOG_TAB}'!A:H`, [[kyiv(Date.now()), brand.toUpperCase(), players.length, customers.length,
    snapshotOnly ? 'снимок недели' : `недельный сброс: ${toReset.length - failed}`, '', secs, status]]);
  console.log(JSON.stringify({ ...summary, failed, secs }));
  if (failed) throw new Error(`${brand.toUpperCase()}: сброс не прошёл у ${failed} игроков`);
  return summary;
}

// неделя без видео-постов (или обратно): строка видео-миссии в карточке у всех игроков миссий.
// Трогаем только тех, у кого видео-миссия ещё не начата (w_view = 0) — прогресс не затираем.
async function setView(brand, mode, { dry = false } = {}) {
  if (!['on', 'off'].includes(mode)) throw new Error('--set-view on | off');
  const m = missionsCfg(brand);
  const want = mode === 'off' ? m.vline_off : m.vline_on;
  const { pageId, idByName, players, states } = await loadPlayers(brand, ['s_vline', 'w_view']);
  const list = states.filter((s) => !(Number(s.v.w_view) > 0) && norm(s.v.s_vline) !== norm(want));
  console.log(`${brand.toUpperCase()}: игроков миссий ${players.length}, поменять s_vline → «${want}»: ${list.length}`);
  if (dry || !list.length) return list.length;
  const failed = await writeFields(pageId, list, [{ id: idByName.s_vline, value: want }]);
  if (failed) throw new Error(`${brand.toUpperCase()}: не записалось у ${failed}`);
  console.log('ok');
  return list.length;
}

async function ensureTab() {
  const m = await sheets.meta('sheets.properties(sheetId,title)');
  let sheet = m.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) {
    await sheets.batchUpdate([{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }]);
    sheet = (await sheets.meta('sheets.properties(sheetId,title)')).sheets.find((s) => s.properties.title === TAB);
  }
  // шапка пишется, если её нет или она старая (коллекция v1, без бренда) — данные под ней не трогаем
  const head = (await sheets.read(`'${TAB}'!A1:${LAST_COL}1`).catch(() => []))[0] || [];
  if (head.join('\u0001') === HEADER.join('\u0001')) return;
  await sheets.write(`'${TAB}'!A1:${LAST_COL}1`, [HEADER], { raw: true });
  const id = sheet.properties.sheetId;
  await sheets.batchUpdate([{ repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy' } }]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = args.brand ? [String(args.brand).toLowerCase()] : bc.brands();
  if (args['set-view']) {
    if (!args.brand) throw new Error('--set-view только с --brand');
    await setView(list[0], String(args['set-view']), { dry: !!args.dry });
    return;
  }
  let failed = 0;
  for (const brand of list) {
    try {
      await run(brand, { dry: !!args.dry, snapshotOnly: !!args['snapshot-only'] });
    } catch (e) {
      failed++;
      console.error(e.message);
      if (!args.dry) {
        sheets.setSpreadsheetId(bc.loadConfig().sheet_id);
        await sheets.append(`'${LOG_TAB}'!A:H`, [[kyiv(Date.now()), brand.toUpperCase(), '', '', 'недельный сброс', '', '', `ошибка: ${e.message}`.slice(0, 500)]]).catch(() => {});
      }
    }
  }
  if (failed) throw new Error(`упало брендов: ${failed} из ${list.length}`);
}

module.exports = { run, setView, weekLabel, defaultsOf };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
