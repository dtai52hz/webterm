// localStorage cho các tiện ích nhỏ theo từng trình duyệt (session gần đây, thư mục đang đóng...).
// Có thể bị chặn hoặc rỗng (cửa sổ ẩn danh), nên mọi thao tác đều bọc try/catch.
export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
