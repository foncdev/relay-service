import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

/**
 * 개인 인증.
 *
 * Docker Hub로 배포되면 각자 자기 NAS에 올린다.
 * 설정 전에는 서버를 잠가두고, 첫 접속에서 관리자 계정을 만들게 한다.
 * 그래야 키를 빠뜨린 채 인터넷에 노출되는 사고를 막을 수 있다.
 */

const scryptAsync = promisify(scrypt);

/** scrypt 파라미터. 값이 클수록 무차별 대입이 느려진다. */
const KEY_LEN = 64;
const SALT_LEN = 16;

/** 세션 토큰 유효 기간. 기본 30일. */
const TOKEN_TTL_MS = Number(process.env.RELAY_TOKEN_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000;

interface StoredAccount {
  /** 로그인 이름. 단일 사용자지만 나중을 위해 남겨둔다. */
  username: string;
  /** salt:hash 형식. 비밀번호 원문은 저장하지 않는다. */
  password: string;
  createdAt: string;
}

interface StoredToken {
  token: string;
  createdAt: string;
  expiresAt: string;
  /** 어떤 기기인지 알아보기 위한 메모. */
  label: string;
}

interface AuthFile {
  account?: StoredAccount;
  tokens: StoredToken[];
}

const FILE = path.join(config.dataDir, 'auth.json');

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** 비밀번호를 해시한다. 같은 비밀번호라도 salt가 달라 결과가 다르다. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/** 저장된 해시와 비교한다. 상수 시간으로 비교해 시간차를 남기지 않는다. */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LEN)) as Buffer;
  const expected = Buffer.from(keyHex, 'hex');
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export class AuthStore {
  private data: AuthFile = { tokens: [] };

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as AuthFile;
      this.data.tokens ??= [];
    } catch {
      // 아직 설정 전이다.
      this.data = { tokens: [] };
    }
  }

  private save(): void {
    // 자격증명 파일은 주인만 읽을 수 있게 한다.
    fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /** 관리자 계정이 만들어졌는지. 안 됐으면 서버는 잠긴 상태다. */
  get isConfigured(): boolean {
    return Boolean(this.data.account);
  }

  get username(): string {
    return this.data.account?.username ?? '';
  }

  /**
   * 첫 설정. 이미 계정이 있으면 거부한다.
   * 열려 있는 설정 경로로 계정이 덮어써지면 곧 탈취로 이어진다.
   */
  async setup(username: string, password: string): Promise<string> {
    if (this.isConfigured) {
      throw new AuthError('이미 설정이 끝났습니다.', 409);
    }
    this.assertStrong(password);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      throw new AuthError('아이디는 영문/숫자/밑줄/하이픈 3~32자여야 합니다.');
    }

    this.data.account = {
      username,
      password: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    this.save();
    return this.issueToken('최초 설정');
  }

  async login(username: string, password: string, label = '기기'): Promise<string> {
    const account = this.data.account;
    if (!account) throw new AuthError('아직 설정되지 않았습니다.', 409);

    // 아이디가 틀려도 같은 시간이 걸리도록 비밀번호 검증을 항상 수행한다.
    const okUser = account.username === username;
    const okPass = await verifyPassword(password, account.password);
    if (!okUser || !okPass) {
      throw new AuthError('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    return this.issueToken(label);
  }

  async changePassword(current: string, next: string): Promise<void> {
    const account = this.data.account;
    if (!account) throw new AuthError('아직 설정되지 않았습니다.', 409);
    if (!(await verifyPassword(current, account.password))) {
      throw new AuthError('현재 비밀번호가 올바르지 않습니다.', 401);
    }
    this.assertStrong(next);

    account.password = await hashPassword(next);
    // 비밀번호를 바꾸면 기존 토큰은 모두 버린다.
    // 유출이 의심될 때 이 동작으로 모든 기기를 끊을 수 있다.
    this.data.tokens = [];
    this.save();
  }

  /** 토큰을 발급한다. 원문은 이때만 볼 수 있다. */
  private issueToken(label: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.data.tokens.push({
      token,
      label,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    });
    this.pruneExpired();
    this.save();
    return token;
  }

  /** 토큰이 유효한지 본다. */
  verifyToken(token: string): boolean {
    if (!token) return false;
    const now = Date.now();
    const found = this.data.tokens.find((t) => {
      const a = Buffer.from(t.token);
      const b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!found) return false;
    if (new Date(found.expiresAt).getTime() < now) {
      this.revoke(token);
      return false;
    }
    return true;
  }

  revoke(token: string): void {
    this.data.tokens = this.data.tokens.filter((t) => t.token !== token);
    this.save();
  }

  /** 모든 기기를 로그아웃시킨다. */
  revokeAll(): void {
    this.data.tokens = [];
    this.save();
  }

  /** 발급된 토큰 목록. 원문은 빼고 보여준다. */
  listTokens(): Array<{ label: string; createdAt: string; expiresAt: string }> {
    return this.data.tokens.map(({ label, createdAt, expiresAt }) => ({
      label,
      createdAt,
      expiresAt,
    }));
  }

  private pruneExpired(): void {
    const now = Date.now();
    this.data.tokens = this.data.tokens.filter(
      (t) => new Date(t.expiresAt).getTime() > now,
    );
  }

  /**
   * 약한 비밀번호를 막는다.
   * 터미널 제어 권한이 걸려 있어 흔한 비밀번호는 위험하다.
   */
  private assertStrong(password: string): void {
    if (password.length < 10) {
      throw new AuthError('비밀번호는 10자 이상이어야 합니다.');
    }
    if (password.length > 200) {
      throw new AuthError('비밀번호가 너무 깁니다.');
    }
    const common = ['password', '12345678', 'qwerty', 'admin123', 'letmein'];
    if (common.some((c) => password.toLowerCase().includes(c))) {
      throw new AuthError('너무 흔한 비밀번호입니다.');
    }
  }
}

export const auth = new AuthStore();

/** agent-cli가 쓸 토큰. 사람 계정과 분리해 둔다. */
export function generateAgentToken(): string {
  return randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
}
