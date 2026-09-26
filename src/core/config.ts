import fs from 'node:fs';
import path from 'node:path';

/** .env를 읽어 process.env에 채운다. 의존성 없이 최소한만 처리한다. */
function loadEnv(): void {
  const file = path.resolve('.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

loadEnv();

export const config = {
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? '0.0.0.0',

  /**
   * agent-cli가 접속할 때 제시하는 토큰.
   * 이게 없으면 아무 맥이나 붙을 수 있으므로 외부 배포 시 반드시 설정한다.
   */
  agentToken: process.env.RELAY_AGENT_TOKEN ?? '',

  /**
   * 클라이언트(relay 앱, G2)가 쓰는 키.
   * 인터넷에 열리는 서버라 비워두면 안 된다.
   */
  clientKey: process.env.RELAY_CLIENT_KEY ?? '',

  /**
   * terminal-agent가 접속할 때 쓰는 토큰.
   *
   * agent-cli와 따로 둔다. 셸을 여는 쪽이라 한쪽 토큰이 새도
   * 터미널까지 넘어가지 않게 한다. 비워두면 접속을 아예 받지 않는다.
   */
  terminalToken: process.env.RELAY_TERMINAL_TOKEN ?? '',

  /**
   * 안경앱 정적 파일. 루트(/)에서 서빙한다.
   * G2가 QR로 루트를 여므로 이 경로를 유지한다.
   */
  glassesRoot: path.resolve(process.env.RELAY_GLASSES_ROOT ?? '../glasses-g2/dist'),

  /**
   * 브라우저용 관리 UI. /web 에서 서빙한다.
   * 안경앱과 달리 이 저장소 안에 있다. Docker는 RELAY_WEB_ROOT로 덮어쓴다.
   */
  webRoot: path.resolve(process.env.RELAY_WEB_ROOT ?? './web/dist'),

  /**
   * 외부 서비스가 알림만 넣을 때 쓰는 키.
   *
   * clientKey와 따로 둔다. 그건 세션·파일·셸까지 여는 마스터라, 남의
   * 자동화나 웹훅에 넘기면 사고가 난다. 이 키로는 알림 추가밖에 못 한다.
   *
   * 비워두면 훅을 아예 닫는다. 기능이 조용히 열려 있는 것보다 낫다.
   */
  hookKey: process.env.RELAY_HOOK_KEY ?? '',

  /** 체크리스트 등 서버가 들고 있는 자료의 위치. */
  dataDir: path.resolve(process.env.RELAY_DATA_DIR ?? './data'),

  /** 분당 요청 상한. 무차별 대입을 늦춘다. */
  rateLimit: Number(process.env.RELAY_RATE_LIMIT ?? 300),

  /**
   * IP당 분당 로그인·초기 설정 시도 상한.
   *
   * 예전에는 일반 요청과 같은 300을 써서 틀린 비밀번호 40번이 그대로
   * 통과했다. 사람이 틀리는 횟수로는 10이면 넉넉하다.
   */
  loginLimit: Number(process.env.RELAY_LOGIN_LIMIT ?? 10),

  /**
   * 리버스 프록시(Caddy·nginx 등) 뒤에 둘 때 켠다. Express의 trust proxy 값이다.
   *
   * 끄면 모든 요청이 프록시 IP로 보여, 시도 제한이 한 사람에게 걸리면
   * 모두가 막힌다. 켜면 X-Forwarded-For를 믿으므로 프록시 없이 켜면 안
   * 된다 — 누구나 헤더로 IP를 바꿔 제한을 피한다. 보통은 1(프록시 한 단).
   */
  trustProxy: process.env.RELAY_TRUST_PROXY ?? '',
} as const;

/**
 * 레거시 클라이언트 키를 받을지.
 *
 * 로그인 없이 셸까지 모든 경로를 여는 마스터 키다. 인터넷에 열린 서버에서
 * 짧으면 대입으로 뚫린다. 24자보다 짧으면 아예 받지 않는다.
 */
export const CLIENT_KEY_MIN = 24;
export const clientKeyUsable = config.clientKey.length >= CLIENT_KEY_MIN;

/** 설정이 위험한 상태면 알려준다. */
export function warnings(): string[] {
  const out: string[] = [];
  if (!config.agentToken) {
    out.push('RELAY_AGENT_TOKEN이 없어 agent 접속을 받지 않습니다.');
  }
  if (config.clientKey && !clientKeyUsable) {
    out.push(`RELAY_CLIENT_KEY가 ${CLIENT_KEY_MIN}자보다 짧아 받지 않습니다. openssl rand -hex 24 로 바꾸세요.`);
  }
  if (config.agentToken && config.agentToken.length < 24) {
    out.push('RELAY_AGENT_TOKEN이 짧습니다. 24자 이상을 권합니다.');
  }
  // 훅 키는 남에게 건네는 값이라 짧으면 더 위험하다.
  if (config.hookKey && config.hookKey.length < 24) {
    out.push('RELAY_HOOK_KEY가 짧습니다. 24자 이상을 권합니다.');
  }
  if (config.hookKey && config.hookKey === config.clientKey) {
    out.push('RELAY_HOOK_KEY가 RELAY_CLIENT_KEY와 같습니다. 훅에 마스터 키를 주면 안 됩니다.');
  }
  return out;
}
