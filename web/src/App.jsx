import React, { useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Forum from './pages/Forum.jsx';
import Thread from './pages/Thread.jsx';
import PostRedirect from './pages/PostRedirect.jsx';
import Members from './pages/Members.jsx';
import Member from './pages/Member.jsx';
import Conversation from './pages/Conversation.jsx';
import NotFound from './pages/NotFound.jsx';

// Lên đầu trang khi đổi trang; giữ nguyên vị trí khi chỉ đổi tab trong trang thành viên.
function ScrollToTop() {
  const { pathname, search, hash, state } = useLocation();
  useEffect(() => {
    if (!hash && !state?.keepScroll) window.scrollTo(0, 0);
  }, [pathname, search, hash, state]);
  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <header className="site-head">
        <div className="site-head-inner">
          <Link to="/" className="brand">V-Westlife</Link>
          <nav className="site-nav" aria-label="Chính">
            <NavLink to="/" end>Diễn đàn</NavLink>
            <NavLink to="/u">Thành viên</NavLink>
          </nav>
          <span className="brand-sub">Bản sao lưu ngày 11/12/2012</span>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/f/:id" element={<Forum />} />
        <Route path="/t/:id" element={<Thread />} />
        <Route path="/p/:id" element={<PostRedirect />} />
        <Route path="/u" element={<Members />} />
        <Route path="/u/:id" element={<Member />} />
        <Route path="/u/:id/:tab" element={<Member />} />
        <Route path="/u/:id/:kind/:other" element={<Conversation />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
