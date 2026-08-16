import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  base: '/dashboard-assets/',
  build: {
    outDir: '../public/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        mipanel: 'mipanel.html',
      },
    },
  },
});
