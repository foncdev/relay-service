import { config } from './config.js';

/**
 * 처음 띄웠을 때 시작 로그에 보여줄 안내.
 *
 * 계정이 없으면 서버는 잠겨 있고(503 setup_required), 무엇을 해야 풀리는지
 * 로그만 봐서는 알 수 없다. 그래서 계정이 생기기 전까지만 순서를 적어준다.
 */
export function firstRunGuide(): string[] {
  // 0.0.0.0은 브라우저로 열 수 없는 주소라 localhost로 바꿔 보여준다.
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const base = `http://${host}:${config.port}`;
  const mark = (value: string) => (value ? '설정됨' : '비어 있음');

  return [
    '─── 처음 실행입니다. 아래 순서로 설정하세요 ───',
    '',
    '1. 관리자 계정 만들기',
    `   브라우저에서 ${base}/web 을 열면 초기 설정 화면이 뜹니다.`,
    '   아이디는 영문/숫자/밑줄/하이픈 3~32자, 비밀번호는 10자 이상입니다.',
    '   계정을 만들기 전까지 API는 503 setup_required로 잠겨 있습니다.',
    '',
    '2. 토큰 채우기 (.env 또는 Docker 환경변수)',
    '   긴 무작위 값을 쓰세요: openssl rand -base64 24',
    `   RELAY_AGENT_TOKEN     일반 agent 접속용       [${mark(config.agentToken)}]`,
    `   RELAY_TERMINAL_TOKEN  terminal-agent 접속용   [${mark(config.terminalToken)}]  비우면 접속 거부`,
    `   RELAY_HOOK_KEY        외부 알림 훅 전용       [${mark(config.hookKey)}]  비우면 훅 닫힘`,
    '   세 값은 서로 다르게 둡니다. 바꾼 뒤에는 서버를 다시 띄웁니다.',
    '',
    '3. agent 붙이기',
    `   ws://${host}:${config.port}/agent?name=<이름>&token=<RELAY_AGENT_TOKEN>`,
    `   ws://${host}:${config.port}/terminal-agent?name=<이름>&token=<RELAY_TERMINAL_TOKEN>`,
    '',
    '자세한 설명은 README의 "처음 실행" 절을 보세요.',
  ];
}
