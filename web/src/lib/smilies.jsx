import React, { createContext, useContext, useEffect, useState } from 'react';
import { getJson } from './api.js';

// Danh sách smilie (mã → ảnh) tải một lần cho cả app. Chưa nhập ảnh thì mã vẫn hiện dạng chữ.
const SmiliesContext = createContext(null);

function build(list) {
  if (!list?.length) return null;
  const map = new Map(list.map((s) => [s.text, s.url]));
  const escaped = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { map, re: new RegExp(escaped.join('|'), 'g') };
}

export function SmiliesProvider({ children }) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    getJson('/api/smilies')
      .then((data) => setValue(build(data.smilies)))
      .catch(() => setValue(null));
  }, []);
  return <SmiliesContext.Provider value={value}>{children}</SmiliesContext.Provider>;
}

export function useSmilies() {
  return useContext(SmiliesContext);
}
