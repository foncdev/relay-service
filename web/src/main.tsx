import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { applyDocumentLocale } from './i18n.js';

// <html lang>과 창 제목을 브라우저 언어에 맞춘다.
applyDocumentLocale();

const root = document.getElementById('root');
if (!root) throw new Error('#root를 찾을 수 없습니다.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
