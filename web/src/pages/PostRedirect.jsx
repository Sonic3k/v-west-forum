import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { Status } from '../components/ui.jsx';

// /p/:id → chủ đề, đúng trang, cuộn tới bài viết.
export default function PostRedirect() {
  const { id } = useParams();
  const { data, loading, error } = useApi(`/api/posts/${id}/locate`);
  if (data) return <Navigate replace to={`/t/${data.threadId}?page=${data.page}#post-${data.postId}`} />;
  return <main className="page"><Status loading={loading} error={error} /></main>;
}
