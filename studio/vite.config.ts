import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is used purely to bundle the frontend (src/web). The Node server in
// src/server serves the resulting dist/ as static files plus its own /api routes.
export default defineConfig({
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  plugins: [react()],
});
