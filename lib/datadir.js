'use strict';
// Thư mục dữ liệu dùng chung (session, khoá mã hoá, settings, macro, tunnel...).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.WEBTERM_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = { DATA_DIR, dataPath: (...parts) => path.join(DATA_DIR, ...parts) };
