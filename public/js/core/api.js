// Gọi REST API của server (cookie token đi kèm tự động).
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = new Error((data && data.error) || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = data && data.code;
    throw e;
  }
  return data;
}
