import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

/**
 * 같은 와이파이의 폰(Relay 앱)이 이 서버를 찾게 알린다(Bonjour).
 *
 * 맥 IP가 바뀌면(공유기가 새로 나눠 주면) 폰에 적어 둔 주소가 틀려 붙지
 * 못했다. 이름으로 알려 두면 폰이 새 IP를 스스로 찾는다.
 *
 * 맥에 기본으로 있는 dns-sd로 알린다. 의존성을 늘리지 않으려고 그렇게 한다.
 * 맥이 아니면(도커·리눅스 서버) 하지 않는다 — 밖에 둔 서버는 폰과 같은
 * 와이파이에 있지 않다.
 */

/** 폰이 찾는 서비스 종류. iOS 앱의 NSBonjourServices와 같아야 한다. */
export const SERVICE_TYPE = '_relay._tcp';

/** 알리는 이름. 폰은 이 이름으로 같은 서버인지 알아본다. */
export function serviceName(): string {
  const host = os.hostname().replace(/\.local$/, '');
  return `relay-service (${host})`;
}

/**
 * 알리기 시작한다. 돌려준 함수를 부르면 멈춘다.
 * 맥이 아니거나 꺼 두었으면 아무것도 하지 않는다.
 */
export function advertise(port: number, opts: { enabled?: boolean; platform?: string } = {}): () => void {
  const enabled = opts.enabled ?? process.env.RELAY_BONJOUR !== 'false';
  if (!enabled || (opts.platform ?? process.platform) !== 'darwin') return () => undefined;

  let child: ChildProcess | undefined;
  try {
    child = spawn('dns-sd', ['-R', serviceName(), SERVICE_TYPE, 'local', String(port), 'path=/'], {
      stdio: 'ignore',
    });
    child.on('error', () => {
      // dns-sd가 없다. 찾기만 못 할 뿐 서버는 그대로 돈다.
      child = undefined;
    });
    // 서버보다 먼저 죽어도 서버를 붙잡지 않는다.
    child.unref();
  } catch {
    return () => undefined;
  }
  return () => {
    child?.kill();
    child = undefined;
  };
}
