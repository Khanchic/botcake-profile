#!/usr/bin/env node
/*
  botcake-sync.js — профиль юзеров BotCake → Google Sheet «BotCake Profile».

  Живёт в GitHub Actions (публичный репо, поэтому бренды, токены и ID таблицы только
  в Secrets), раз в час его дёргает cron-job.org. Комп не нужен. Только экосистема FB: к казино не привязываемся.

  За прогон (по каждому бренду из конфига, см. шапку botcake.js):
    1) полный список юзеров страницы из BotCake API (~800 запросов на 8 тыс. юзеров);
    2) история tags — только тем, у кого с прошлого прогона сменилась активность
       или набор tags, плюс новым. С --full — всем (бэкфилл, ~8 тыс. запросов);
    3) из истории считает дни, когда юзеру ставили STREAK_TAG (Daily Prize Claimed):
       всего, за 30 дней, текущий и лучший стрик;
    4) переписывает вкладку бренда целиком и добавляет строку во вкладку «Лог».

  Таблица и есть состояние между прогонами: служебные колонки _last_utc и _events
  (скрыты) хранят сырую активность и даты событий. Юзеров, которых не было в
  очередном проходе (список сдвигается, пока его читаешь), не удаляем — их строка
  просто не обновляется.

  Вкладка в таблице = alias бренда заглавными. ID таблицы — sheet_id из конфига.

  CLI:
    node automation/botcake-sync.js --setup                — один раз: локаль, вкладка «Лог»
    node automation/botcake-sync.js --all                  — все бренды из конфига (так в Actions)
    node automation/botcake-sync.js --brand <alias>        — один бренд
    node automation/botcake-sync.js --brand <alias> --full — пересчитать историю всем
    node automation/botcake-sync.js --brand <alias> --dry  — всё посчитать, в таблицу не писать

  Дни считаются по часовому поясу страниц BotCake (GMT-5, без перехода на летнее),
  колонки со временем — по Киеву.
*/
const sheets = require('./sheets');
const bc = require('./botcake');

const LOG_TAB = 'Лог';
const STREAK_TAG = 'Daily Prize Claimed';
const PAGE_TZ_OFFSET_H = -5;
const EVENTS_KEEP_DAYS = 120;
const CONCURRENCY = 10;

const HEADER = [
  // «Первый контакт с ботом» = date_subscribed_at BotCake: первое взаимодействие с ботом
  // (коммент с ответом в личку, личка, ссылка), а не подписка на FB-страницу.
  'PSID', 'Имя', 'Первый контакт с ботом', 'Последняя активность (Kyiv)', 'Дней без активности',
  'Tags', 'ad_id',
  `${STREAK_TAG}: всего`, `${STREAK_TAG}: 30 дней`, 'Стрик сейчас', 'Лучший стрик', 'Последний claim',
  'В синке с', 'Обновлено (Kyiv)', '_last_utc', '_events',
];
const COL = Object.fromEntries(HEADER.map((h, i) => [h, i]));
const LAST_COL = sheets.indexToCol(HEADER.length - 1);
const LOG_HEADER = ['Время (Kyiv)', 'Бренд', 'Юзеров в таблице', 'Прошли в API', 'Новых', 'Обновлена история', 'Секунд', 'Статус'];

const kyiv = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).slice(0, 16);
const pageDay = (ms) => new Date(ms + PAGE_TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
const utcMs = (s) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
const DAY = 86400e3;

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
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Дни с событием → всего, за 30 дней, текущий и лучший стрик. Текущий стрик жив,
// если последний claim сегодня или вчера: сегодняшний юзер мог ещё не забрать.
function streakStats(days, nowMs) {
  const sorted = [...new Set(days)].sort();
  const today = pageDay(nowMs);
  const yesterday = pageDay(nowMs - DAY);
  const from30 = pageDay(nowMs - 29 * DAY);
  let best = 0; let run = 0; let prev = null;
  for (const d of sorted) {
    run = prev && Date.parse(d) - Date.parse(prev) === DAY ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  const last = sorted[sorted.length - 1] || '';
  const current = last === today || last === yesterday ? run : 0;
  return { total: sorted.length, last30: sorted.filter((d) => d >= from30).length, current, best, last };
}

async function setup() {
  const m = await sheets.meta('properties(title,locale,timeZone),sheets.properties(sheetId,title)');
  const reqs = [{
    updateSpreadsheetProperties: {
      properties: { locale: 'en_US', timeZone: 'Europe/Kiev' }, fields: 'locale,timeZone',
    },
  }];
  // Вкладки брендов заводит сам прогон (ensureBrandTab). У свежего файла единственный
  // лист переименовываем в «Лог», а не добавляем рядом: так не остаётся пустого «Лист1».
  const titles = m.sheets.map((s) => s.properties.title);
  if (!titles.includes(LOG_TAB)) {
    reqs.push(m.sheets.length === 1
      ? { updateSheetProperties: { properties: { sheetId: m.sheets[0].properties.sheetId, title: LOG_TAB }, fields: 'title' } }
      : { addSheet: { properties: { title: LOG_TAB } } });
  }
  await sheets.batchUpdate(reqs);
  await sheets.write(`'${LOG_TAB}'!A1:H1`, [LOG_HEADER], { raw: true });
  const m2 = await sheets.meta('sheets.properties(sheetId,title)');
  const logId = m2.sheets.find((s) => s.properties.title === LOG_TAB).properties.sheetId;
  await sheets.batchUpdate([
    { updateSheetProperties: { properties: { sheetId: logId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId: logId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
  ]);
  console.log('таблица готова: вкладка «Лог», локаль en_US, пояс Europe/Kiev');
}

async function formatBrandTab(tab) {
  const m = await sheets.meta('sheets.properties(sheetId,title)');
  const id = m.sheets.find((s) => s.properties.title === tab).properties.sheetId;
  await sheets.write(`'${tab}'!A1:${LAST_COL}1`, [HEADER], { raw: true });
  const hiddenFrom = COL._last_utc;
  await sheets.batchUpdate([
    { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
    { repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: hiddenFrom, endIndex: HEADER.length }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
  ]);
}

async function ensureBrandTab(tab) {
  const m = await sheets.meta('sheets.properties(sheetId,title)');
  if (m.sheets.some((s) => s.properties.title === tab)) return;
  await sheets.batchUpdate([{ addSheet: { properties: { title: tab } } }]);
  await formatBrandTab(tab);
}

async function readState(tab) {
  const rows = await sheets.read(`'${tab}'!A2:${LAST_COL}`);
  const state = new Map();
  for (const r of rows) {
    const psid = r[COL.PSID];
    if (!psid) continue;
    let events = {};
    try { events = JSON.parse(r[COL._events] || '{}'); } catch (_) { /* битая ячейка — пересчитаем */ }
    state.set(psid, {
      name: r[COL['Имя']] || '',
      subscribed: r[COL['Первый контакт с ботом']] || '',
      tags: r[COL.Tags] || '',
      adId: r[COL.ad_id] || '',
      since: r[COL['В синке с']] || '',
      updated: r[COL['Обновлено (Kyiv)']] || '',
      lastUtc: r[COL._last_utc] || '',
      events,
    });
  }
  return state;
}

async function sync(brand, { full = false, dry = false } = {}) {
  const started = Date.now();
  const pageId = bc.pageIdOf(brand);
  const tab = brand.toUpperCase();
  if (!dry) await ensureBrandTab(tab);

  const [state, tagList, customers] = await Promise.all([
    readState(tab),
    bc.getTags(pageId),
    bc.listCustomers(pageId, { concurrency: CONCURRENCY }),
  ]);
  const tagName = new Map(tagList.map((t) => [t.id, t.name]));
  const nowMs = Date.now();
  const nowKyiv = kyiv(nowMs);
  const cutoff = pageDay(nowMs - EVENTS_KEEP_DAYS * DAY);

  const tagsOf = (c) => (c.tags || []).map((t) => t.name).sort().join(' | ');
  const toRefresh = customers.filter((c) => {
    const old = state.get(c.psid);
    return full || !old || old.lastUtc !== c.last_interactive_at || old.tags !== tagsOf(c);
  });
  const newCount = customers.filter((c) => !state.has(c.psid)).length;

  const histories = await pool(toRefresh, CONCURRENCY, (c) => bc.getHistory(pageId, c.psid));
  const freshEvents = new Map();
  toRefresh.forEach((c, i) => {
    const ev = {};
    for (const h of histories[i]) {
      if (h.type !== 'TAG' || (h.payload || {}).action !== 'add') continue;
      const name = tagName.get(h.payload.tag_id) || String(h.payload.tag_id);
      const day = pageDay(utcMs(h.inserted_at));
      if (day < cutoff) continue;
      (ev[name] = ev[name] || []).push(day);
    }
    for (const k of Object.keys(ev)) ev[k] = [...new Set(ev[k])].sort();
    freshEvents.set(c.psid, ev);
  });

  // Сливаем: свежие из API поверх старых строк; кого API в этот раз не отдал — остаются как были.
  const merged = new Map(state);
  for (const c of customers) {
    const old = state.get(c.psid);
    merged.set(c.psid, {
      name: c.full_name || '',
      subscribed: c.date_subscribed_at || '',
      tags: tagsOf(c),
      adId: c.ad_id || (c.ad_ids || [])[0] || '',
      since: old ? old.since : nowKyiv.slice(0, 10),
      updated: freshEvents.has(c.psid) || !old ? nowKyiv : old.updated,
      lastUtc: c.last_interactive_at || '',
      events: freshEvents.get(c.psid) || (old ? old.events : {}),
    });
  }

  const rows = [...merged.entries()].map(([psid, u]) => {
    const lastMs = u.lastUtc ? utcMs(u.lastUtc) : null;
    const s = streakStats(u.events[STREAK_TAG] || [], nowMs);
    const row = new Array(HEADER.length).fill('');
    row[COL.PSID] = psid;
    row[COL['Имя']] = u.name;
    row[COL['Первый контакт с ботом']] = u.subscribed;
    row[COL['Последняя активность (Kyiv)']] = lastMs ? kyiv(lastMs) : '';
    row[COL['Дней без активности']] = lastMs ? Math.floor((nowMs - lastMs) / DAY) : '';
    row[COL.Tags] = u.tags;
    row[COL.ad_id] = u.adId;
    row[COL[`${STREAK_TAG}: всего`]] = s.total;
    row[COL[`${STREAK_TAG}: 30 дней`]] = s.last30;
    row[COL['Стрик сейчас']] = s.current;
    row[COL['Лучший стрик']] = s.best;
    row[COL['Последний claim']] = s.last;
    row[COL['В синке с']] = u.since;
    row[COL['Обновлено (Kyiv)']] = u.updated;
    row[COL._last_utc] = u.lastUtc;
    row[COL._events] = JSON.stringify(u.events);
    return { lastMs: lastMs || 0, row };
  }).sort((a, b) => b.lastMs - a.lastMs).map((x) => x.row);

  const seconds = Math.round((Date.now() - started) / 1000);
  const summary = { brand: tab, total: rows.length, scanned: customers.length, new: newCount, refreshed: toRefresh.length, seconds };

  if (dry) {
    console.log('--dry, в таблицу не пишу:', JSON.stringify(summary));
    const withClaims = rows.filter((r) => r[COL[`${STREAK_TAG}: всего`]] > 0).length;
    console.log(`с ${STREAK_TAG}: ${withClaims}, стрик сейчас ≥3: ${rows.filter((r) => r[COL['Стрик сейчас']] >= 3).length}`);
    return summary;
  }

  // PSID и даты пишем RAW: в USER_ENTERED 17-значный PSID превратится в число и потеряет цифры.
  // Шапку пишем каждый раз вместе с данными — переименование колонки в HEADER доезжает само.
  await sheets.write(`'${tab}'!A1:${LAST_COL}${rows.length + 1}`, [HEADER, ...rows], { raw: true });
  await sheets.append(`'${LOG_TAB}'!A:H`, [[nowKyiv, tab, rows.length, customers.length, newCount, toRefresh.length, Math.round((Date.now() - started) / 1000), 'ok']]);
  console.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = bc.loadConfig();
  if (!config.sheet_id) throw new Error('в конфиге BotCake нет sheet_id');
  sheets.setSpreadsheetId(config.sheet_id);
  if (args.setup) return setup();
  if (!args.brand && !args.all) throw new Error('нужен --all, --brand <alias> или --setup');

  // Бренды идут по очереди: упал один — остальные всё равно синкаются, код выхода 1 в конце.
  const list = args.all ? bc.brands() : [String(args.brand).toLowerCase()];
  let failed = 0;
  for (const brand of list) {
    try {
      await sync(brand, { full: !!args.full, dry: !!args.dry });
    } catch (e) {
      failed++;
      console.error(`${brand.toUpperCase()}: ${e.message}`);
      // Пишем падение в Лог, чтобы тишина в таблице не выглядела как «всё ок».
      if (!args.dry) {
        await sheets.append(`'${LOG_TAB}'!A:H`, [[kyiv(Date.now()), brand.toUpperCase(), '', '', '', '', '', `ошибка: ${e.message}`.slice(0, 500)]])
          .catch(() => {});
      }
    }
  }
  if (failed) throw new Error(`упало брендов: ${failed} из ${list.length}`);
}

module.exports = { sync, streakStats };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
