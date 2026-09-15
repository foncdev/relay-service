import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root를 찾을 수 없습니다.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
