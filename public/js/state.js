// Trạng thái dùng chung giữa các module + bus sự kiện nhỏ để các module không phải import vòng.
export const state = {
  ready: false,
  sessions: [],
  multiExec: false,
  selectedSession: null,
  activeKey: 'home',
  capabilities: { localFeatures: false, platform: '', vault: { enabled: false, locked: false } },
  settings: null,
};

export const tabs = new Map();

const target = new EventTarget();
const providers = {};
export const bus = {
  on(type, fn) {
    target.addEventListener(type, (e) => fn(e.detail));
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
  // Điểm mở rộng: module khác đăng ký thêm mục (vd. menu chuột phải của SFTP).
  provide(type, fn) {
    (providers[type] ||= []).push(fn);
  },
  collect(type, arg) {
    return (providers[type] || []).flatMap((fn) => fn(arg) || []);
  },
};

export const activeTab = () => tabs.get(state.activeKey) || null;
