/**
 * 모니터링의 공통 모양. Grafana에서 무엇이 오든 이 모양으로 바꿔 내보낸다.
 * 안경·폰·웹은 이것만 그린다 — 지표가 늘어도 화면 코드는 그대로다.
 *
 *   그룹 → 대상 → 지표 · 서비스(UP/DOWN)
 *   운영 웹 → web-01 → CPU 23%, 디스크 40%, nginx UP        (서버: 라벨로 대상을 가른다)
 *   쇼핑몰  → 오늘   → 주문 1,284건, 반품 37건               (업무 지표: 설정에 대상을 적는다)
 */

/** 나쁜 순서. 묶음의 상태는 그 안에서 가장 나쁜 것이다. unknown은 값이 없을 때. */
export type MonitorState = 'down' | 'crit' | 'warn' | 'ok' | 'unknown';

export const STATE_RANK: Record<MonitorState, number> = { down: 4, crit: 3, warn: 2, unknown: 1, ok: 0 };

export function worst(states: MonitorState[]): MonitorState {
  return states.reduce<MonitorState>((a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a), 'ok');
}

export interface MonitorMetric {
  /** 설정의 지표 키(cpu·disk …) */
  key: string;
  /** 화면에 쓸 이름(CPU·디스크 …) */
  label: string;
  value: number;
  unit: string;
  /** 막대를 그릴 때의 끝값. 없으면 막대 없이 값만 */
  max?: number;
  state: MonitorState;
}

export interface MonitorService {
  name: string;
  up: boolean;
}

/** 그룹 안의 대상 하나. 서버일 수도, '오늘'처럼 업무 지표를 모은 묶음일 수도 있다. */
export interface MonitorItem {
  id: string;
  name: string;
  state: MonitorState;
  metrics: MonitorMetric[];
  services: MonitorService[];
}

export interface MonitorGroup {
  id: string;
  name: string;
  state: MonitorState;
  /** 상태별 대상 수 */
  counts: Record<MonitorState, number>;
  /** 서비스 UP/전체 */
  servicesUp: number;
  servicesTotal: number;
  items: MonitorItem[];
}

export interface MonitorSnapshot {
  /** off면 설정이 없다(안경은 메뉴를 숨긴다) */
  enabled: boolean;
  /** grafana · demo */
  source: string;
  updatedAt?: string;
  /** 마지막 조회가 실패했으면 그 까닭. 그 전 값은 그대로 둔다(stale). */
  error?: string;
  stale?: boolean;
  state: MonitorState;
  counts: Record<MonitorState, number>;
  groups: MonitorGroup[];
}

/** 원천(Grafana 등)에서 받은 시계열 하나의 현재 값. 라벨과 숫자뿐이다. */
export interface Series {
  labels: Record<string, string>;
  value: number;
}

/** 한 번 조회한 원자료. 지표 키마다 시계열들, 서비스 시계열들, 업무 지표 키마다 값 하나. */
export interface Sample {
  metrics: Record<string, Series[]>;
  services: Series[];
  stats: Record<string, number | undefined>;
}
