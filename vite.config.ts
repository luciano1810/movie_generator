import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.HOST ?? '0.0.0.0';

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/storage': 'http://127.0.0.1:3001'
    }
  },
  preview: {
    host,
    port: 5173
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true
  }
});
