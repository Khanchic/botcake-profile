#!/usr/bin/env node
/*
  botcake-sync.js — профиль юзеров BotCake → Google Sheet «BotCake Profile».

  Живёт в GitHub Actions (публичный репо, поэтому бренды, токены и ID таблицы только
  в Secrets), раз в час его дёргает cron-job.org. Комп не нужен. Только экосистема FB: к казино не привязываемся.

  За прогон (по каждому бренду из конфига, см. шапку botcake.js):
    1) полный список юзеров страницы из BotCake API (~800 запросов на 8 тыс. юзеров);
    2) история tags — только тем, у кого с прошлого прогона сменилась активность
       или набор tags, плюс новым. С --full — всем (бэкфилл, ~8 тыс. запросов);
    3) по каждому tag из track_tags бренда (конфиг) считает дни, когда юзеру его
       ставили: всего, за 30 дней, последний раз; со "streak": true — ещё текущий
       и лучший стрик;
    4) переписывает вкладку бренда целиком и добавляет строку во вкладку «Лог».

  track_tags в конфиге бренда — список строк или { "name": "...", "streak": true }.
  Новый tag миссии = дописать его туда и обновить Secret (botcake-profile-push.js
  secrets); код трогать не нужно, колонки появятся на следующем прогоне.

  Таблица и есть состояние между прогонами: служебные колонки _last_utc и _events
  (скрыты) хранят сырую активность и даты ВСЕХ tags за 120 дней — поэтому tag,
  добавленный в track_tags позже, сразу получает историю. Старые строки читаются
  по названиям колонок, а не по позициям: смена набора колонок их не ломает.
  Юзеров, которых не было в очередном проходе (список сдвигается, пока его
  читаешь), не удаляем — их строка просто не обновляется.

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
const PAGE_TZ_OFFSET_H = -5;
const EVENTS_KEEP_DAYS = 120;
const CONCURRENCY = 10;

// «Первый контакт с ботом» = date_subscribed_at BotCake: первое взаимодействие с ботом
// (коммент с ответом в личку, личка, ссылка), а не подписка на FB-страницу.
const BASE_COLS = ['PSID', 'Имя', 'Первый контакт с ботом', 'Последняя активность (Kyiv)', 'Дней без активности', 'Tags', 'ad_id'];
const TAIL_COLS = ['В синке с', 'Обновлено (Kyiv)', '_last_utc', '_events'];
const HIDDEN_COLS = ['_last_utc', '_events'];

function trackTagsOf(brand) {
  const raw = bc.loadConfig().brands[brand].track_tags || [];
  return raw.map((t) => (typeof t === 'string' ? { name: t, streak: false } : { name: t.name, streak: !!t.streak }));
}

const tagCols = (t) => [
  `${t.name}: дней всего`, `${t.name}: за 30 дней`, `${t.name}: последний раз`,
  ...(t.streak ? [`${t.name}: стрик сейчас`, `${t.name}: лучший стрик`] : []),
];

const headerOf = (tracked) => [...BASE_COLS, ...tracked.flatMap(tagCols), ...TAIL_COLS];
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

async function tabSheetId(tab) {
  const m = await sheets.meta('sheets.properties(sheetId,title)');
  const s = m.sheets.find((x) => x.properties.title === tab);
  return s ? s.properties.sheetId : null;
}

async function ensureBrandTab(tab) {
  if (await tabSheetId(tab) !== null) return;
  await sheets.batchUpdate([{ addSheet: { properties: { title: tab } } }]);
  const id = await tabSheetId(tab);
  await sheets.batchUpdate([
    { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
    { repeatCell: { range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy' } },
  ]);
}

/* Набор колонок поменялся (новый tag в track_tags) → данные уже записаны по новой
   шапке; добиваем вид: хвост старой, более широкой шапки чистим, служебные колонки
   прячем заново (их позиции сдвинулись), остальные показываем. */
async function relayoutTab(tab, header, oldWidth, rowCount) {
  const id = await tabSheetId(tab);
  const width = Math.max(header.length, oldWidth);
  const reqs = [
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 0, endIndex: width }, properties: { hiddenByUser: false }, fields: 'hiddenByUser' } },
    ...HIDDEN_COLS.map((name) => {
      const i = header.indexOf(name);
      return { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } };
    }),
  ];
  if (oldWidth > header.length) {
    reqs.push({ updateCells: { range: { sheetId: id, startRowIndex: 0, endRowIndex: rowCount + 1, startColumnIndex: header.length, endColumnIndex: oldWidth }, fields: 'userEnteredValue' } });
  }
  await sheets.batchUpdate(reqs);
}

// Читаем по названиям колонок из шапки, которая лежит в таблице сейчас, а не по позициям:
// после смены track_tags старые строки иначе съехали бы.
async function readState(tab) {
  const rows = await sheets.read(`'${tab}'!A1:ZZ`);
  const oldHeader = rows[0] || [];
  const at = Object.fromEntries(oldHeader.map((h, i) => [h, i]));
  const get = (r, name) => (at[name] === undefined ? '' : r[at[name]] || '');
  const state = new Map();
  for (const r of rows.slice(1)) {
    const psid = get(r, 'PSID');
    if (!psid) continue;
    let events = {};
    try { events = JSON.parse(get(r, '_events') || '{}'); } catch (_) { /* битая ячейка — пересчитаем */ }
    state.set(psid, {
      name: get(r, 'Имя'),
      subscribed: get(r, 'Первый контакт с ботом'),
      tags: get(r, 'Tags'),
      adId: get(r, 'ad_id'),
      since: get(r, 'В синке с'),
      updated: get(r, 'Обновлено (Kyiv)'),
      lastUtc: get(r, '_last_utc'),
      events,
    });
  }
  return { state, oldHeader };
}

async function sync(brand, { full = false, dry = false } = {}) {
  const started = Date.now();
  const pageId = bc.pageIdOf(brand);
  const tab = brand.toUpperCase();
  const tracked = trackTagsOf(brand);
  const header = headerOf(tracked);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  if (!dry) await ensureBrandTab(tab);

  const [{ state, oldHeader }, tagList, customers] = await Promise.all([
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
    const row = new Array(header.length).fill('');
    row[col.PSID] = psid;
    row[col['Имя']] = u.name;
    row[col['Первый контакт с ботом']] = u.subscribed;
    row[col['Последняя активность (Kyiv)']] = lastMs ? kyiv(lastMs) : '';
    row[col['Дней без активности']] = lastMs ? Math.floor((nowMs - lastMs) / DAY) : '';
    row[col.Tags] = u.tags;
    row[col.ad_id] = u.adId;
    for (const t of tracked) {
      const s = streakStats(u.events[t.name] || [], nowMs);
      row[col[`${t.name}: дней всего`]] = s.total;
      row[col[`${t.name}: за 30 дней`]] = s.last30;
      row[col[`${t.name}: последний раз`]] = s.last;
      if (t.streak) {
        row[col[`${t.name}: стрик сейчас`]] = s.current;
        row[col[`${t.name}: лучший стрик`]] = s.best;
      }
    }
    row[col['В синке с']] = u.since;
    row[col['Обновлено (Kyiv)']] = u.updated;
    row[col._last_utc] = u.lastUtc;
    row[col._events] = JSON.stringify(u.events);
    return { lastMs: lastMs || 0, row };
  }).sort((a, b) => b.lastMs - a.lastMs).map((x) => x.row);

  const seconds = Math.round((Date.now() - started) / 1000);
  const summary = { brand: tab, total: rows.length, scanned: customers.length, new: newCount, refreshed: toRefresh.length, seconds };

  if (dry) {
    console.log('--dry, в таблицу не пишу:', JSON.stringify(summary));
    for (const t of tracked) {
      const n = rows.filter((r) => r[col[`${t.name}: дней всего`]] > 0).length;
      console.log(`  ${t.name}: у ${n} юзеров за ${EVENTS_KEEP_DAYS} дней`);
    }
    return summary;
  }

  // PSID и даты пишем RAW: в USER_ENTERED 17-значный PSID превратится в число и потеряет цифры.
  // Шапку пишем каждый раз вместе с данными — новые колонки и переименования доезжают сами.
  const lastCol = sheets.indexToCol(header.length - 1);
  await sheets.write(`'${tab}'!A1:${lastCol}${rows.length + 1}`, [header, ...rows], { raw: true });
  if (oldHeader.join('\u0001') !== header.join('\u0001')) await relayoutTab(tab, header, oldHeader.length, rows.length);
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
