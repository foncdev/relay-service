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

  /** 체크리스트 등 서버가 들고 있는 자료의 위치. */
  dataDir: path.resolve(process.env.RELAY_DATA_DIR ?? './data'),

  /** 분당 요청 상한. 무차별 대입을 늦춘다. */
  rateLimit: Number(process.env.RELAY_RATE_LIMIT ?? 300),
} as const;

/** 설정이 위험한 상태면 알려준다. */
export function warnings(): string[] {
  const out: string[] = [];
  if (!config.agentToken) {
    out.push('RELAY_AGENT_TOKEN이 없습니다. 누구나 agent로 붙을 수 있습니다.');
  }
  if (!config.clientKey) {
    out.push('RELAY_CLIENT_KEY가 없습니다. 누구나 세션을 조작할 수 있습니다.');
  } else if (config.clientKey.length < 24) {
    out.push('RELAY_CLIENT_KEY가 짧습니다. 24자 이상을 권합니다.');
  }
  if (config.agentToken && config.agentToken.length < 24) {
    out.push('RELAY_AGENT_TOKEN이 짧습니다. 24자 이상을 권합니다.');
  }
  return out;
}
