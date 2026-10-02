import React from 'react';
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="page">
      <h1 className="page-title">Không có trang này</h1>
      <p>Đường dẫn không khớp với box, chủ đề hay bài viết nào. <Link to="/">Về trang chủ</Link></p>
    </main>
  );
}
