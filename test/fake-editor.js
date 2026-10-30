'use strict';
// "Editor" giả cho test tính năng sửa bằng app ngoài: mở file, đợi một chút rồi lưu
// theo kiểu nhiều editor hay làm (ghi file mới bên cạnh rồi đổi tên đè lên file cũ).
// File có chữ "conflict" trong tên thì không sửa gì (test tự sửa để tạo xung đột).
const fs = require('fs');

const file = process.argv[2];
if (!file || file.includes('conflict')) process.exit(0);
setTimeout(() => {
  const content = fs.readFileSync(file, 'utf8') + 'sửa bằng editor ngoài\n';
  fs.writeFileSync(file + '.swp', content);
  fs.renameSync(file + '.swp', file);
}, 400);
