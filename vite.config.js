import { defineConfig } from 'vite';

// GitHub Pages 주소: https://youngbaekim.github.io/yb-pdf/
export default defineConfig({
  base: '/yb-pdf/',
  build: { chunkSizeWarningLimit: 2500, target: 'es2022' },
});
