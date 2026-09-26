/**
 * 초기화 명령.
 *
 *   npm run reset                 계정과 로그인 토큰만 지운다
 *   npm run reset -- --all        알림·체크리스트·스니펫까지 전부
 *   node dist/reset.js [--all]    Docker 안에서
 *
 * 웹에 두지 않는다. 인터넷에 열린 서버라 누구나 계정을 날리고 새로 만들
 * 수 있게 되기 때문이다. 이 명령은 서버 파일에 손댈 수 있는 사람만 쓴다.
 *
 * 지우지 않고 옮겨 둔다. 잘못 돌려도 되살릴 수 있어야 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from './core/config.js';

const args = new Set(process.argv.slice(2));
const all = args.has('--all');
const yes = args.has('--yes') || args.has('-y');

/** 20260926-131500 형식. 기존 auth.json.bak.* 이름과 맞춘다. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 서버가 떠 있는지 본다.
 *
 * 떠 있으면 계정을 메모리에 들고 있어서, 파일을 지워도 다음 저장 때 도로
 * 써진다. 초기화가 된 줄 알았는데 안 된 상태가 가장 나쁘므로 막는다.
 */
async function serverRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/auth/status`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('확인할 수 없는 환경입니다. 정말 초기화하려면 --yes를 붙이세요.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (yes 입력): `);
  rl.close();
  return answer.trim() === 'yes';
}

async function main(): Promise<number> {
  const dir = config.dataDir;
  if (!fs.existsSync(dir)) {
    console.log(`데이터 폴더가 없습니다: ${dir}\n초기화할 것이 없습니다.`);
    return 0;
  }

  if (await serverRunning()) {
    console.error(
      `서버가 :${config.port}에서 돌고 있습니다. 먼저 멈추세요.\n` +
        '떠 있는 서버가 계정을 들고 있어, 파일을 지워도 다시 써집니다.',
    );
    return 1;
  }

  const targets = all
    ? fs.readdirSync(dir).filter((name) => !name.startsWith('reset-') && !name.includes('.bak.'))
    : ['auth.json'].filter((name) => fs.existsSync(path.join(dir, name)));

  if (targets.length === 0) {
    console.log('계정이 아직 없습니다. 초기화할 것이 없습니다.');
    return 0;
  }

  console.log(`데이터 폴더: ${dir}`);
  console.log(all ? '모든 자료를 초기화합니다:' : '계정과 로그인 토큰을 초기화합니다:');
  for (const name of targets) console.log(`  - ${name}`);
  if (!all) console.log('알림·체크리스트·스니펫은 그대로 남습니다.');
  console.log('모든 기기가 로그아웃됩니다.');

  if (!(await confirm('계속할까요?'))) {
    console.log('취소했습니다.');
    return 1;
  }

  const ts = stamp();
  if (all) {
    const backup = path.join(dir, `reset-${ts}`);
    fs.mkdirSync(backup);
    for (const name of targets) fs.renameSync(path.join(dir, name), path.join(backup, name));
    console.log(`옮겨 두었습니다: ${backup}`);
  } else {
    const backup = path.join(dir, `auth.json.bak.${ts}`);
    fs.renameSync(path.join(dir, 'auth.json'), backup);
    console.log(`옮겨 두었습니다: ${backup}`);
  }

  console.log('\n서버를 다시 띄운 뒤 /web 에서 계정을 새로 만드세요.');
  return 0;
}

process.exit(await main());
