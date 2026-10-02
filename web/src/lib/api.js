import { useEffect, useState } from 'react';

export async function getJson(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Máy chủ trả về lỗi ${res.status}.`);
  return body;
}

// Tải dữ liệu theo đường dẫn API; giữ dữ liệu cũ trong lúc tải trang mới.
export function useApi(path) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getJson(path)
      .then((data) => alive && setState({ loading: false, data, error: null }))
      .catch((err) => alive && setState({ loading: false, data: null, error: err.message }));
    return () => {
      alive = false;
    };
  }, [path]);
  return state;
}
