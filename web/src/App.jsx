import React, { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Forum from './pages/Forum.jsx';
import Thread from './pages/Thread.jsx';
import PostRedirect from './pages/PostRedirect.jsx';
import NotFound from './pages/NotFound.jsx';

function ScrollToTop() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, search, hash]);
  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <header className="site-head">
        <div className="site-head-inner">
          <Link to="/" className="brand">V-Westlife</Link>
          <span className="brand-sub">Kho lưu trữ diễn đàn, bản sao lưu ngày 11/12/2012</span>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/f/:id" element={<Forum />} />
        <Route path="/t/:id" element={<Thread />} />
        <Route path="/p/:id" element={<PostRedirect />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
