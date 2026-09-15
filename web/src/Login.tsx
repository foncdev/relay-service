import { useEffect, useState } from 'react';
import { BANNER, TAGLINE } from './banner.js';
import { api, setToken, type AuthStatus } from './api.js';

/**
 * 로그인 / 최초 설정 화면.
 *
 * 서버에 계정이 없으면 설정 화면으로, 있으면 로그인 화면으로 바뀐다.
 * 설정이 끝나기 전에는 서버가 잠겨 있으므로 이 화면을 지나야 한다.
 */
export function Login({ onDone }: { onDone: (username: string) => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authStatus()
      .then(setStatus)
      .catch(() => setError('서버에 연결할 수 없습니다.'));
  }, []);

  const isSetup = status?.configured === false;

  async function submit(): Promise<void> {
    if (busy) return;
    setError('');

    if (isSetup && password !== confirm) {
      setError('비밀번호가 서로 다릅니다.');
      return;
    }

    setBusy(true);
    try {
      const result = isSetup
        ? await api.setup(username.trim(), password)
        : await api.login(username.trim(), password);
      setToken(result.token);
      onDone(result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : '실패했습니다.');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="login">
        <div className="login-box">{error || '연결 중…'}</div>
      </div>
    );
  }

  const ready = username.trim() && password && (!isSetup || confirm);

  return (
    <div className="login">
      {/* 좁은 화면에서는 가로로 넘치므로 CSS에서 숨긴다. */}
      <pre className="banner" aria-label="FONCDEV">
        {BANNER}
      </pre>
      <p className="banner-tag">{TAGLINE}</p>
      <form
        className="login-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>{isSetup ? '초기 설정' : '로그인'}</h1>
        <p className="hint">
          {isSetup
            ? '관리자 계정을 만듭니다. 이 계정으로 에이전트를 제어하므로 비밀번호를 신중히 정하세요.'
            : 'Relay 서버에 로그인합니다.'}
        </p>

        <div className="field">
          <label htmlFor="login-user">아이디</label>
          <input
            id="login-user"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={isSetup ? '영문/숫자 3~32자' : ''}
          />
        </div>

        <div className="field">
          <label htmlFor="login-pw">비밀번호</label>
          <input
            id="login-pw"
            type="password"
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? '10자 이상' : ''}
          />
        </div>

        {isSetup && (
          <div className="field">
            <label htmlFor="login-pw2">비밀번호 확인</label>
            <input
              id="login-pw2"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        <button className="primary" type="submit" disabled={!ready || busy}>
          {busy ? '처리 중…' : isSetup ? '계정 만들기' : '로그인'}
        </button>
      </form>
    </div>
  );
}
