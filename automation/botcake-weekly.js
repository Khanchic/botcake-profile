#!/usr/bin/env node
/*
  botcake-weekly.js — недельный цикл миссий: снимок недели во вкладку «Миссии» и сброс прогресса.

  Запуск в GitHub Actions по cron-job.org в понедельник 00:00 America/New_York
  (workflow_dispatch с inputs.task = weekly). Порядок: сначала снимок, потом сброс —
  чтобы цифры прошлой недели не потерялись.

  Кого трогаем: только игроков миссий — у кого есть tag M_STARTED (его ставит первый шаг).
  Массовое чтение поля в API отдаёт значения без PSID, поэтому поля читаем по каждому
  игроку отдельно (их сотни, не тысячи).

  Строка отчёта = неделя: игроки с шагом, выполнения по 5 миссиям (= сколько раз выдан
  код каждой миссии), коллекция 0/1/2/3, золотые (= джекпот-коды), призы недели,
  новые спешл-бонусы за подписку (прирост tag SUB_BONUS_GOT к прошлой строке).

  CLI:
    node automation/botcake-weekly.js --brand sr --dry     — посчитать и показать, ничего не писать
    node automation/botcake-weekly.js --brand sr           — снимок + сброс
    node automation/botcake-weekly.js --brand sr --snapshot-only
*/
const sheets = require('./sheets');
const bc = require('./botcake');

const TAB = 'Миссии';
const LOG_TAB = 'Лог';
const STARTED_TAG = 'M_STARTED';
const BONUS_TAG = 'SUB_BONUS_GOT';

// значения после сброса; True/False через публичный API — строкой
const DEFAULTS = {
  w_view: '0', w_pz: '0', w_done: '0',
  w_view_r1: 'false', w_view_r2: 'false', w_view_r3: 'false', w_view_r4: 'false',
  w_pz_p1: 'false', w_pz_p2: 'false', w_pz_p3: 'false', w_pz_p4: 'false', w_pz_p5: 'false', w_pz_p6: 'false', w_pz_p7: 'false',
  s_view: '0/2', s_pz: '0/3', w_pred: '0/1', w_sub: '0/1', w_story: '0/1',
  c_a: '⬜', c_b: '⬜', c_c: '⬜', c_gold: ' ', c_last: ' ', c_set: 'false',
  r_line: ' ', r_drop: ' ', r_all: ' ',
};
const GOALS = { w_view: 2, w_pz: 3 };
// API хранит ' ' как null — сравниваем без пробелов
const norm = (x) => String(x ?? '').trim();
// в c_a/c_b/c_c лежит ⬜ или эмодзи предмета, в c_gold — '+ 🌟'
const hasItem = (x) => !['', '⬜'].includes(norm(x));

const HEADER = [
  'Неделя (пн, ET)', 'Снимок (Kyiv)', 'Игроков с шагом',
  '🎬 Viewer — кодов', '🧩 Solver — кодов', '🔮 Predictor — кодов', '📨 Subscriber — кодов', '📲 Story — кодов',
  'Коллекция 0', 'Коллекция 1', 'Коллекция 2', 'Коллекция 3',
  '🌟 Джекпот — кодов', '🏆 Приз недели — кодов', '🎁 Спешл-бонус — кодов (новые подписки)',
  'SUB_BONUS_GOT всего', 'Сброшено игроков',
];

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

async function run(brand, { dry = false, snapshotOnly = false } = {}) {
  const started = Date.now();
  const pageId = bc.pageIdOf(brand);
  const fieldList = await bc.getCustomFields(pageId);
  const idByName = Object.fromEntries(fieldList.map((f) => [f.name, String(f.id)]));
  const nameById = Object.fromEntries(fieldList.map((f) => [String(f.id), f.name]));
  const missing = Object.keys(DEFAULTS).filter((n) => !idByName[n]);
  if (missing.length) throw new Error(`на странице нет полей: ${missing.join(', ')}`);

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

  const done = (s) => ({
    view: Number(s.v.w_view) >= GOALS.w_view,
    pz: Number(s.v.w_pz) >= GOALS.w_pz,
    pred: String(s.v.w_pred || '').startsWith('✅'),
    sub: s.v.w_sub === '✅',
    story: s.v.w_story === '✅',
  });
  const active = (s) => Number(s.v.w_view) > 0 || Number(s.v.w_pz) > 0 || Number(s.v.w_done) > 0
    || String(s.v.w_pred || '').startsWith('✅') || s.v.w_sub === '✅' || s.v.w_story === '✅';
  const coll = [0, 0, 0, 0];
  let view = 0, pz = 0, pred = 0, sub = 0, story = 0, gold = 0, prize = 0, act = 0;
  for (const s of states) {
    const d = done(s);
    view += d.view; pz += d.pz; pred += d.pred; sub += d.sub; story += d.story;
    if (active(s)) act++;
    coll[['c_a', 'c_b', 'c_c'].filter((k) => hasItem(s.v[k])).length]++;
    if (norm(s.v.c_gold).includes('🌟')) gold++;
    if (s.v.c_set === 'true') prize++;
  }

  sheets.setSpreadsheetId(bc.loadConfig().sheet_id);
  const prevRows = dry ? [] : await sheets.read(`'${TAB}'!A2:Q`).catch(() => []);
  const prevBonus = prevRows.length ? Number(prevRows[prevRows.length - 1][15] || 0) : bonusTotal;

  const toReset = states.filter((s) => Object.entries(DEFAULTS).some(([n, def]) => norm(s.v[n]) !== norm(def)));
  const row = [weekLabel(Date.now()), kyiv(Date.now()), act, view, pz, pred, sub, story, ...coll, gold, prize,
    Math.max(0, bonusTotal - prevBonus), bonusTotal, snapshotOnly ? 0 : toReset.length];

  const summary = { brand: brand.toUpperCase(), players: players.length, active: act, toReset: toReset.length, row };
  if (dry) { console.log('--dry:', JSON.stringify(summary)); return summary; }

  // снимок
  await ensureTab();
  await sheets.append(`'${TAB}'!A:Q`, [row]);

  // сброс
  let failed = 0;
  if (!snapshotOnly) {
    const data = Object.entries(DEFAULTS).map(([n, value]) => ({ id: idByName[n], value }));
    await pool(toReset, 5, async (s) => {
      try { await bc.api(pageId, `/customer/${s.psid}/customer_fields`, { method: 'POST', body: { psid: s.psid, data } }); } catch (_) { failed++; }
    });
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const status = failed ? `сброс: ошибок ${failed}` : 'ok';
  await sheets.append(`'${LOG_TAB}'!A:H`, [[kyiv(Date.now()), brand.toUpperCase(), players.length, customers.length,
    snapshotOnly ? 'снимок недели' : `недельный сброс: ${toReset.length - failed}`, '', secs, status]]);
  console.log(JSON.stringify({ ...summary, failed, secs }));
  if (failed) throw new Error(`сброс не прошёл у ${failed} игроков`);
  return summary;
}

async function ensureTab() {
  const m = await sheets.meta('sheets.properties(sheetId,title)');
  if (m.sheets.some((s) => s.properties.title === TAB)) return;
  await sheets.batchUpdate([{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }]);
  await sheets.write(`'${TAB}'!A1:Q1`, [HEADER], { raw: true });
  const id = (await sheets.meta('sheets.properties(sheetId,title)')).sheets.find((s) => s.properties.title === TAB).properties.sheetId;
  await sheets.batchUpdate([{ repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy' } }]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = args.brand ? [String(args.brand).toLowerCase()] : bc.brands();
  for (const brand of list) await run(brand, { dry: !!args.dry, snapshotOnly: !!args['snapshot-only'] });
}

module.exports = { run, weekLabel, DEFAULTS };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
