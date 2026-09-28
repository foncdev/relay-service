import { useEffect, useState } from 'react';
import { BANNER } from './banner.js';
import { api, setToken, type AuthStatus } from './api.js';
import { msg } from './i18n.js';

/**
 * 로그인 / 최초 설정 화면.
 *
 * 서버에 계정이 없으면 설정 화면으로, 있으면 로그인 화면으로 바뀐다.
 * 설정이 끝나기 전에는 서버가 잠겨 있으므로 이 화면을 지나야 한다.
 */
export function Login({ onDone }: { onDone: (username: string) => void }) {
  const t = msg();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authStatus()
      .then(setStatus)
      .catch(() => setError(msg().cannotReachServer));
  }, []);

  const isSetup = status?.configured === false;

  async function submit(): Promise<void> {
    if (busy) return;
    setError('');

    if (isSetup && password !== confirm) {
      setError(t.passwordMismatch);
      return;
    }

    setBusy(true);
    try {
      const result = isSetup
        ? await api.setup(username.trim(), password, code.trim())
        : await api.login(username.trim(), password);
      setToken(result.token);
      onDone(result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="login">
        <div className="login-box">{error || t.connecting}</div>
      </div>
    );
  }

  const ready = username.trim() && password && (!isSetup || (confirm && code.trim()));

  return (
    <div className="login">
      {/* 좁은 화면에서는 가로로 넘치므로 CSS에서 숨긴다. */}
      <pre className="banner" aria-label="FONCDEV">
        {BANNER}
      </pre>
      {/* 태그라인은 banner.ts의 TAGLINE(서버와 같은 한국어)을 언어별로 옮긴 것이다. */}
      <p className="banner-tag">{t.tagline}</p>
      <form
        className="login-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>{isSetup ? t.setupTitle : t.signIn}</h1>
        <p className="hint">
          {isSetup ? t.setupHint : t.signInHint}
        </p>

        {/* 설정 코드는 서버 로그에만 찍힌다. 로그를 볼 수 있는 사람만 계정을 만든다. */}
        {isSetup && (
          <div className="field">
            <label htmlFor="login-code">{t.setupCode}</label>
            <input
              id="login-code"
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t.setupCodePlaceholder}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="login-user">{t.username}</label>
          <input
            id="login-user"
            autoFocus={!isSetup}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={isSetup ? t.usernamePlaceholder : ''}
          />
        </div>

        <div className="field">
          <label htmlFor="login-pw">{t.password}</label>
          <input
            id="login-pw"
            type="password"
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? t.passwordPlaceholder : ''}
          />
        </div>

        {isSetup && (
          <div className="field">
            <label htmlFor="login-pw2">{t.passwordConfirm}</label>
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
          {busy ? t.working : isSetup ? t.createAccount : t.signIn}
        </button>
      </form>
    </div>
  );
}
