import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * 인터넷에 열리는 서버라 인증을 조심스럽게 다룬다.
 *
 * 키 비교는 상수 시간으로, 요청 빈도는 제한한다.
 * 둘 다 없으면 키를 한 글자씩 알아내거나 무차별로 시도할 여지가 생긴다.
 */

/**
 * 키를 상수 시간으로 비교한다.
 *
 * === 로 비교하면 앞부분이 맞을수록 늦게 실패해, 그 시간차로 키를 알아낼 수 있다.
 * 길이가 달라도 시간이 새지 않도록 같은 길이로 맞춰 비교한다.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // 길이가 다르면 어차피 불일치지만, 비교 자체는 수행해 시간차를 없앤다.
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/**
 * 아주 단순한 요청 빈도 제한.
 *
 * 출처별로 분당 횟수를 센다. 개인 서버라 메모리에만 둬도 충분하다.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  /**
   * @param limit 창 하나에 허용할 횟수. 설정을 바꿔 가며 쓰도록 함수로 받는다.
   * @param windowMs 창 길이.
   */
  constructor(
    private readonly limit: () => number,
    private readonly windowMs = 60_000,
  ) {}

  /** 허용되면 true. 넘어서면 false. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return 1 <= this.limit();
    }

    entry.count += 1;
    return entry.count <= this.limit();
  }

  /** 세지 않고, 지금 창에서 이미 한도에 닿았는지만 본다. */
  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && Date.now() <= entry.resetAt && entry.count >= this.limit();
  }

  /** 오래된 기록을 치운다. 메모리가 계속 늘지 않게 한다. */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(key);
    }
  }
}

export const rateLimiter = new RateLimiter(() => config.rateLimit);

/**
 * 로그인·초기 설정 시도. IP당 분당 config.loginLimit번.
 *
 * 일반 요청과 같은 한도(300)를 쓰던 때는 틀린 비밀번호 40번이 그대로
 * 통과했다.
 */
export const loginLimiter = new RateLimiter(() => config.loginLimit);

/**
 * 모든 IP를 합친 로그인 실패. 10분에 100번을 넘으면 그 창이 끝날 때까지
 * 새 로그인을 받지 않는다.
 *
 * IP를 바꿔 가며 시도하면 IP별 제한은 소용이 없다. 대신 그동안은 주인도
 * 새로 로그인하지 못한다. 이미 로그인한 기기는 그대로 쓴다.
 */
export const globalLoginFailures = new RateLimiter(() => 100, 10 * 60_000);

/** 실패한 인증을 기록한다. 로그로 이상 징후를 알아볼 수 있게 한다. */
export function logAuthFailure(ip: string, path: string): void {
  console.warn(`[relay] 인증 실패: ${ip} ${path}`);
}
