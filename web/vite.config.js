import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // API port; keep in sync with the server: PORT=4100 npm start <-> PORT=4100 npm run dev
    proxy: { '/api': `http://localhost:${process.env.PORT || 4000}` },
  },
  build: { outDir: 'dist' },
});
