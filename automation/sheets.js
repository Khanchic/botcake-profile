#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPREADSHEET_ID = '';
// Скрипти, що працюють з іншою таблицею, викликають setSpreadsheetId() до першого запиту.
// ACTIVE_ID — стан на рівні модуля, спільний для всього процесу. Якщо два скрипти з різними
// таблицями завантажити в один процес, останній require переміг би — і запис молча пішов би
// в чужу таблицю. Тому конфліктний повторний виклик падає з помилкою, а не переписує тихо.
let ACTIVE_ID = SPREADSHEET_ID;
let PINNED = false;
function setSpreadsheetId(id) {
  if (!id) throw new Error('setSpreadsheetId: порожній id');
  if (PINNED && ACTIVE_ID !== id) {
    throw new Error(
      `setSpreadsheetId: таблицю вже зафіксовано на ${ACTIVE_ID}, спроба перевести на ${id}. ` +
      'Два скрипти з різними таблицями не можуть жити в одному процесі: запусти їх окремими ' +
      'викликами node, або передавай id параметром замість модульного сеттера.'
    );
  }
  ACTIVE_ID = id;
  PINNED = true;
}
const KEY_PATH = path.join(__dirname, 'secrets', 'gsheets-key.json');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEET = '';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function loadKey() {
  if (!fs.existsSync(KEY_PATH)) { console.error(`ERROR: ключ не знайдено: ${KEY_PATH}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
}

async function getToken() {
  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.private_key));
  const jwt = `${signingInput}.${signature}`;
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) { console.error('ERROR token:', JSON.stringify(data)); process.exit(1); }
  return data.access_token;
}

async function api(pathAndQuery, opts = {}) {
  const token = opts.token || await getToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${ACTIVE_ID}${pathAndQuery}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { throw new Error(`Sheets API ${res.status}: ${JSON.stringify(data)}`); }
  return data;
}

async function meta(fields) {
  return api(`?fields=${encodeURIComponent(fields || 'properties.title,sheets.properties(sheetId,title,gridProperties)')}`);
}
async function read(range) {
  const data = await api(`/values/${encodeURIComponent(range)}`);
  return data.values || [];
}
async function write(range, values, { raw = false } = {}) {
  const rows = Array.isArray(values[0]) ? values : values.map(v => [v]);
  return api(`/values/${encodeURIComponent(range)}?valueInputOption=${raw ? 'RAW' : 'USER_ENTERED'}`,
    { method: 'PUT', body: { values: rows } });
}
// One HTTP write for many ranges. Sheets allows only 60 write requests per minute per user,
// so anything that touches dozens of cells must batch instead of looping over write().
// data: [{ range, values }] — values may be a flat array (written as a column) or rows.
async function writeMany(data, { raw = false } = {}) {
  if (!data.length) return null;
  return api(`/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: raw ? 'RAW' : 'USER_ENTERED',
      data: data.map(d => ({
        range: d.range,
        values: Array.isArray(d.values[0]) ? d.values : d.values.map(v => [v]),
      })),
    },
  });
}
async function append(range, values, { raw = true } = {}) {
  const rows = Array.isArray(values[0]) ? values : values.map(v => [v]);
  return api(`/values/${encodeURIComponent(range)}:append?valueInputOption=${raw ? 'RAW' : 'USER_ENTERED'}&insertDataOption=OVERWRITE`,
    { method: 'POST', body: { values: rows } });
}

const A = 'A'.charCodeAt(0);
function colToIndex(col) { let n = 0; for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - A + 1); return n - 1; }
function indexToCol(idx) { let s = ''; idx++; while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(A + m) + s; idx = (idx - m - 1) / 26; } return s; }

async function batchUpdate(requests) { return api('/:batchUpdate', { method: 'POST', body: { requests } }); }

async function findWeekColumn(dateStr) {
  const header = (await read(`${SHEET}!A1:BZ1`))[0] || [];
  const idx = header.findIndex(v => (v || '').trim() === dateStr);
  if (idx >= 0) return indexToCol(idx);
  let last = 3; header.forEach((v, i) => { if ((v || '').trim()) last = i; });
  return indexToCol(last + 1);
}

async function ensureFormula(row, col, gid = 0) {
  const dst = colToIndex(col);
  const cur = (await read(`${SHEET}!${col}${row}`));
  if (cur.length && cur[0].length && cur[0][0] !== '') return false;
  await batchUpdate([{
    copyPaste: {
      source:      { sheetId: gid, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: dst - 1, endColumnIndex: dst },
      destination: { sheetId: gid, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: dst,     endColumnIndex: dst + 1 },
      pasteType: 'PASTE_FORMULA',
    },
  }]);
  return true;
}

module.exports = { getToken, read, write, writeMany, append, meta, batchUpdate, findWeekColumn, ensureFormula, colToIndex, indexToCol, setSpreadsheetId, SPREADSHEET_ID, SHEET };

if (require.main === module) {
  (async () => {
    const [cmd, arg1, arg2] = process.argv.slice(2);
    try {
      if (cmd === 'meta') {
        const m = await meta();
        console.log('Таблиця:', m.properties.title);
        m.sheets.forEach(s => console.log(` - "${s.properties.title}"  ${s.properties.gridProperties.rowCount}x${s.properties.gridProperties.columnCount}`));
      } else if (cmd === 'read') {
        console.log(JSON.stringify(await read(arg1), null, 2));
      } else if (cmd === 'write') {
        const vals = arg2.includes(',') ? arg2.split(',') : [arg2];
        const r = await write(arg1, vals);
        console.log(`OK: оновлено ${r.updatedCells} комірок у ${r.updatedRange}`);
      } else {
        console.log('meta | read <range> | write <range> <value[,value...]>');
      }
    } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
  })();
}
