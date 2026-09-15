import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 개발 서버가 API를 넘길 대상. 기본은 relay-service. */
const API = process.env.RELAY_API_URL ?? 'http://127.0.0.1:4100';

// API는 relay-service가 받는다. 인증도 그쪽에 있다.
// terminals를 빠뜨리면 개발 서버에서 터미널 탭이 동작하지 않는다.
const apiPaths = [
  '/auth',
  '/relay',
  '/motd',
  '/sessions',
  '/workspaces',
  '/jobs',
  '/files',
  '/terminals',
  '/checklist',
  '/notifications',
  '/health',
];

export default defineConfig({
  // relay-service가 /web 아래에서 서빙하므로 자원 경로도 맞춘다.
  // 이게 없으면 /assets/... 를 찾아 404가 난다.
  base: '/web/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: Object.fromEntries(
      apiPaths.map((p) => [p, { target: API, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 소스맵은 기본으로 끈다. 켜면 .map이 이미지에 함께 실려 원본
    // 소스가 그대로 나가고 크기도 JS보다 커진다.
    //
    // 콘솔 스택을 소스 줄로 되짚어야 할 때만 잠깐 켠다:
    //   npx vite build --sourcemap
    sourcemap: false,
  },
});
