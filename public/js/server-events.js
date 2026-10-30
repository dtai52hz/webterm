// Nhận sự kiện từ server (SSE) và phát lại lên bus dưới tên "sse:<loại>".
import { bus } from './state.js';

const TYPES = ['settings', 'tunnels', 'vault', 'edit-sync'];

export function connectServerEvents() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  for (const type of TYPES) {
    es.addEventListener(type, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {}
      bus.emit(`sse:${type}`, data);
    });
  }
  es.addEventListener('hello', () => bus.emit('sse:hello'));
}
