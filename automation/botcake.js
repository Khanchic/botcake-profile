#!/usr/bin/env node
/*
  botcake.js — тонкий клиент BotCake Public API. Модуль + CLI.

  Здесь только транспорт, токены и выгрузка — никакой логики миссий. Скрипты
  миссий/профиля игрока подключают этот модуль и строят своё поверх.

  Бренды, page_id, токены и ID таблицы — только в конфиге, в коде их нет
  (репо публичный):
    1) переменная окружения BOTCAKE_CONFIG_JSON (так в GitHub Actions)
    2) automation/secrets/botcake-config.json (локально, папка в .gitignore)
  Формат:
    { "sheet_id": "<id Google Sheet>",
      "brands": { "<alias>": { "page_id": "<FB page id>", "token": "<API key>" } } }
  Ключ генерится в BotCake: Settings → Integrations → вкладка API → Generate
  Your API key. Refresh/Delete ключа в BotCake ломает всё на старом — после
  этого обновить конфиг (и GitHub Secret).

  Docs: https://docs.pancake.biz/docs/botcake/st-f7/st-p2?lang=en

  CLI (--brand: alias из конфига):
    node automation/botcake.js ping      --brand <alias>     — ключ живой? сколько тегов, первая страница юзеров
    node automation/botcake.js tags      --brand <alias>     — теги страницы с id
    node automation/botcake.js fields    --brand <alias>     — User Fields страницы с id
    node automation/botcake.js flows     --brand <alias>     — flows с id (нужны для send_flow)
    node automation/botcake.js customer  --brand <alias> --psid <psid>
                                                             — история тегов/sequence + User Fields юзера
    node automation/botcake.js customers --brand <alias> [--out <файл.json>]
                                                             — все юзеры страницы → JSON + CSV
    node automation/botcake.js set-field --brand <alias> --psid <psid> --field <id> --value <v>
                                                             — записать одно User Field юзеру

  Особенности API (проверено 20.10.2026):
  - /customer отдаёт голый массив по 10 штук, размер страницы не меняется
    (page_size/limit игнорируются). Конец списка = пустой массив.
  - Неверный/отозванный токен = 400 с пустым телом, а не 401.
  - Лимит: ~2100 запросов подряд (замер 20.10 при ~9 req/s), потом 400
    {"message":"limit_reached"} и через ~10 с отпускает. api() сам ждёт и повторяет.
  - Несуществующий путь = 200 {"success":false} — не путать с пустыми данными.
  - Время в API — UTC. Интерфейс BotCake показывает его в часовом поясе
    страницы (у нас GMT-5), поэтому в UI тот же тег на 5 ч раньше.
  - send_flow шлёт сообщение живому юзеру — в CLI его нет специально,
    только как функция модуля.
*/
const fs = require('fs');
const path = require('path');

const BASE = 'https://botcake.io/api/public_api/v1';
const CONFIG_PATH = path.join(__dirname, 'secrets', 'botcake-config.json');
const OUT_DIR = path.join(__dirname, '..', 'output', 'botcake-profile');

let CONFIG = null;
function loadConfig() {
  if (CONFIG) return CONFIG;
  const raw = (process.env.BOTCAKE_CONFIG_JSON || '').trim()
    || (fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '');
  if (!raw) throw new Error('нет конфига BotCake: BOTCAKE_CONFIG_JSON или automation/secrets/botcake-config.json');
  CONFIG = JSON.parse(raw);
  if (!CONFIG.brands || !Object.keys(CONFIG.brands).length) throw new Error('в конфиге BotCake нет brands');
  return CONFIG;
}

const brands = () => Object.keys(loadConfig().brands);

function pageIdOf(alias) {
  const s = String(alias || '').trim().toLowerCase();
  const b = loadConfig().brands[s];
  if (!b) throw new Error(`нет бренда "${alias}" в конфиге. Есть: ${brands().join(', ')}`);
  return String(b.page_id);
}

function tokenOf(pageId) {
  const b = Object.values(loadConfig().brands).find((x) => String(x.page_id) === String(pageId));
  if (!b || !b.token) throw new Error(`нет токена BotCake для страницы ${mask(pageId)} в конфиге`);
  return String(b.token).trim();
}

// Логи Actions в публичном репо видят все — длинные числа (PSID, page_id) режем до 4 цифр.
const mask = (s) => String(s).replace(/\d{9,}/g, (d) => `${d.slice(0, 4)}…`);

async function api(pageId, pathAndQuery, opts = {}) {
  const token = tokenOf(pageId);
  const url = `${BASE}/pages/${pageId}${pathAndQuery}`;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'access-token': token, 'Content-Type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      // обрыв соединения («fetch failed») на длинных проходах бывает — повторяем, как 5xx
      if (attempt < 4) { await new Promise((r) => setTimeout(r, (attempt + 1) * 2000)); continue; }
      throw e;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
      continue;
    }

    const text = await res.text();
    // Лимит API: ~2100 запросов подряд, дальше 400 limit_reached, отпускает через ~10 с.
    // Обычный прогон в него не упирается, бэкфилл историй — да; просто ждём.
    if (res.status === 400 && text.includes('limit_reached') && attempt < 30) {
      await new Promise((r) => setTimeout(r, 12000));
      continue;
    }
    if (!res.ok) {
      const hint = res.status === 400 && !text ? ' (токен неверный или отозван)' : '';
      throw new Error(mask(`BotCake API ${res.status}${hint}: ${pathAndQuery} ${text.slice(0, 300)}`));
    }
    const data = text ? JSON.parse(text) : {};
    // Несуществующий путь отвечает 200 {"success":false} — иначе это выглядит как «данных нет».
    if (data && !Array.isArray(data) && data.success === false) {
      throw new Error(mask(`BotCake API: success=false на ${pathAndQuery} (опечатка в пути или нет доступа)`));
    }
    return data;
  }
}

const getTags = async (pageId) => (await api(pageId, '/get_list_tag')).data || [];
const getCustomFields = async (pageId) => (await api(pageId, '/custom_fields?page=0')).data || [];
const getFlows = async (pageId) => ((await api(pageId, '/flows')).data || {}).flows || [];
const getHistory = async (pageId, psid) => (await api(pageId, `/customer/${psid}`)).histories || [];
const getCustomerFields = async (pageId, psid) => (await api(pageId, `/customer/${psid}/customer_fields`)).data || [];

async function getCustomersPage(pageId, page) {
  const data = await api(pageId, `/customer?page=${page}`);
  return Array.isArray(data) ? data : [];
}

/* Весь список юзеров. Страница фиксированно 10 штук, поэтому идём пачками
   по `concurrency` страниц параллельно, пока пачка не вернёт пустую страницу.
   Список сортирован по последней активности: кто написал боту во время прохода,
   уезжает наверх и сдвигает страницы, поэтому дедуп по psid обязателен,
   а пара человек может выпасть — для профиля это некритично. */
async function listCustomers(pageId, { concurrency = 5, onProgress } = {}) {
  const byPsid = new Map();
  let page = 1;
  let done = false;
  while (!done) {
    const pages = Array.from({ length: concurrency }, (_, i) => page + i);
    const results = await Promise.all(pages.map((p) => getCustomersPage(pageId, p)));
    for (const rows of results) {
      if (!rows.length) { done = true; continue; }
      for (const c of rows) byPsid.set(c.psid, c);
    }
    page += concurrency;
    if (onProgress) onProgress(byPsid.size, page - 1);
  }
  return [...byPsid.values()];
}

async function setCustomerField(pageId, psid, fieldId, value) {
  return api(pageId, `/customer/${psid}/customer_fields`, {
    method: 'POST',
    body: { psid: String(psid), data: [{ id: Number(fieldId), value }] },
  });
}

// Шлёт flow живому юзеру в Messenger. Только из кода, осознанно.
async function sendFlow(pageId, psid, flowId, payload) {
  return api(pageId, '/flows/send_flow', {
    method: 'POST',
    body: { psid: String(psid), flow_id: Number(flowId), ...(payload ? { payload } : {}) },
  });
}

function toCsv(customers) {
  const cols = ['psid', 'full_name', 'tags', 'date_subscribed_at', 'last_interactive_at', 'ad_id', 'ad_ids', 'phone_number', 'disable_bot'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = customers.map((c) => [
    c.psid,
    c.full_name,
    (c.tags || []).map((t) => t.name).join('|'),
    c.date_subscribed_at,
    c.last_interactive_at,
    c.ad_id,
    (c.ad_ids || []).join('|'),
    (c.phone_number || []).join('|'),
    c.disable_bot,
  ].map(esc).join(','));
  // BOM — чтобы Excel не ломал имена с диакритикой.
  return '﻿' + [cols.join(','), ...lines].join('\n') + '\n';
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }
  const pageId = pageIdOf(args.brand);

  if (cmd === 'ping') {
    const [tags, first] = await Promise.all([getTags(pageId), getCustomersPage(pageId, 1)]);
    console.log(`OK: ${args.brand}, тегов ${tags.length}, на первой странице юзеров ${first.length}`);
    if (first[0]) console.log(`последний активный: ${first[0].full_name} (${first[0].last_interactive_at} UTC)`);
    return;
  }
  if (cmd === 'tags') {
    for (const t of await getTags(pageId)) console.log(`${t.id}\t${t.name}`);
    return;
  }
  if (cmd === 'fields') {
    const fields = await getCustomFields(pageId);
    if (!fields.length) console.log('User Fields на странице нет');
    for (const f of fields) console.log(`${f.id}\t${f.name}\t${f.type || ''}`);
    return;
  }
  if (cmd === 'flows') {
    for (const f of await getFlows(pageId)) if (!f.is_removed) console.log(`${f.id}\t${f.name}`);
    return;
  }
  if (cmd === 'customer') {
    if (!args.psid) throw new Error('нужен --psid');
    const [history, fields, tags] = await Promise.all([
      getHistory(pageId, args.psid), getCustomerFields(pageId, args.psid), getTags(pageId),
    ]);
    const tagName = new Map(tags.map((t) => [t.id, t.name]));
    console.log(`История (UTC), ${history.length} записей:`);
    for (const h of history) {
      const p = h.payload || {};
      const what = h.type === 'TAG' ? `tag "${tagName.get(p.tag_id) || p.tag_id}"`
        : h.type === 'SEQUENCE' ? `sequence ${p.sequence_id}` : JSON.stringify(p);
      console.log(`  ${h.inserted_at}  ${h.type} ${p.action || ''} ${what}`);
    }
    console.log(fields.length ? 'User Fields:' : 'User Fields: нет');
    for (const f of fields) console.log(`  ${JSON.stringify(f)}`);
    return;
  }
  if (cmd === 'customers') {
    const started = Date.now();
    const customers = await listCustomers(pageId, {
      onProgress: (n, pages) => { if (pages % 100 === 0) process.stderr.write(`  ...${pages} стр., ${n} юзеров\n`); },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const brand = String(args.brand).toLowerCase();
    const outJson = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `${brand}-customers-${stamp}.json`);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(customers, null, 2));
    const outCsv = outJson.replace(/\.json$/i, '') + '.csv';
    fs.writeFileSync(outCsv, toCsv(customers));

    const tagCount = {};
    for (const c of customers) for (const t of c.tags || []) tagCount[t.name] = (tagCount[t.name] || 0) + 1;
    console.log(`${customers.length} юзеров за ${Math.round((Date.now() - started) / 1000)} с`);
    console.log(`  ${outJson}\n  ${outCsv}`);
    console.log('По тегам:');
    for (const [name, n] of Object.entries(tagCount).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${name}`);
    return;
  }
  if (cmd === 'set-field') {
    if (!args.psid || !args.field || args.value === undefined) throw new Error('нужны --psid, --field, --value');
    const res = await setCustomerField(pageId, args.psid, args.field, String(args.value));
    console.log(JSON.stringify(res));
    return;
  }
  throw new Error(`неизвестная команда "${cmd}". Без аргументов — справка`);
}

module.exports = {
  loadConfig, brands, pageIdOf, mask, api, getTags, getCustomFields, getFlows, getHistory, getCustomerFields,
  getCustomersPage, listCustomers, setCustomerField, sendFlow, toCsv,
};

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
