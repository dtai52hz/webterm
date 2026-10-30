'use strict';
// Macro / lệnh nhanh (giống tab Macros của MobaXterm).
// kind 'text': danh sách lệnh, mỗi dòng có thể kèm Enter. kind 'keys': chuỗi phím gõ đã ghi lại.
const crypto = require('crypto');
const { dataPath } = require('./datadir');
const { collection } = require('./jsonstore');
const { cleanText, badRequest } = require('./store');

const macros = collection(dataPath('macros.json'));
const MAX_BODY = 20000;

function validate(input) {
  const name = cleanText(input.name, 100);
  if (!name) throw badRequest('Tên macro không được để trống');
  const kind = input.kind === 'keys' ? 'keys' : 'text';
  const out = { name, folder: cleanText(input.folder, 100).replace(/\\/g, '/'), kind };
  if (kind === 'text') {
    out.text = String(input.text ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_BODY);
    if (!out.text.trim()) throw badRequest('Macro chưa có lệnh nào');
    out.enter = input.enter !== false;
    const delay = Math.round(Number(input.delay ?? 150));
    out.delay = Number.isFinite(delay) ? Math.max(0, Math.min(10000, delay)) : 150;
  } else {
    out.keys = String(input.keys ?? '').slice(0, MAX_BODY);
    if (!out.keys) throw badRequest('Macro chưa có phím nào');
  }
  return out;
}

const list = () => macros.list();

function create(input) {
  const now = new Date().toISOString();
  return macros.insert({ id: crypto.randomUUID(), ...validate(input), createdAt: now, updatedAt: now });
}

function update(id, input) {
  const cur = macros.get(id);
  if (!cur) return null;
  return macros.update(id, () => ({ id, ...validate({ ...cur, ...input }), createdAt: cur.createdAt, updatedAt: new Date().toISOString() }));
}

const remove = (id) => macros.remove(id);

module.exports = { list, create, update, remove, collection: macros, validate };
