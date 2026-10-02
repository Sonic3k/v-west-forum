import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi chạy thử trên máy: `npm run dev` ở web/ và server chạy ở cổng 8080.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
