/**
 * 확장 에이전트 레지스트리.
 *
 * mac-agent처럼 따로 운영하는 에이전트가 붙는 일반 통로다. 서버는 에이전트가
 * 무엇을 하는지 모른다. 이름으로 나눠 요청을 넘기고, 에이전트가 알려 준 기능
 * 목록을 앱에 그대로 보여 줄 뿐이다. 그래야 에이전트가 기능을 늘려도 서버를
 * 다시 낼 필요가 없다.
 *
 * 요청·스트림 중계는 AgentRegistry를 그대로 쓴다. 여기서는 이름별로 묶고,
 * 접속 직후의 hello와 이후의 기능 목록 갱신만 따로 받는다.
 */

import type { WebSocket } from 'ws';
import { AgentRegistry } from './agents.js';

/** 이 서버가 아는 확장 규약 버전. 에이전트는 welcome에서 이 값을 보고 판단한다. */
export const EXT_PROTOCOL = 1;

/** 에이전트 이름. 경로(/ext/<이름>)에 그대로 쓰이므로 좁게 받는다. */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** 기능 하나. 못 쓰는 기능도 사유와 함께 보낸다 — 앱이 안내를 띄울 수 있게. */
export interface ExtCapability {
  id: string;
  ready: boolean;
  reason?: string;
}

export interface ExtAgentInfo {
  agent: string;
  /** 접속한 기기 이름. 맥 호스트 이름 등. */
  name: string;
  protocol: number;
  version: string;
  capabilities: ExtCapability[];
  connectedAt: string;
}

/** 에이전트가 남기는 알림. 서버가 알림 목록에 넣는다. */
export interface ExtNotice {
  agent: string;
  title: string;
  body: string;
  kind: 'done' | 'error' | 'info';
}

/** 에이전트 하나가 분당 남길 수 있는 알림 수. 고장 난 에이전트가 목록을 덮지 않게. */
const NOTIFY_PER_MINUTE = 20;

/** 기능 목록이 지나치게 커지지 않게 자른다. 앱 메뉴로 그릴 정도면 충분하다. */
const MAX_CAPABILITIES = 64;

/** 에이전트가 보낸 기능 목록을 믿을 만한 모양으로 다듬는다. */
export function sanitizeCapabilities(raw: unknown): ExtCapability[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtCapability[] = [];
  for (const c of raw.slice(0, MAX_CAPABILITIES)) {
    if (!c || typeof c !== 'object') continue;
    const { id, ready, reason } = c as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w.-]{1,40}$/.test(id)) continue;
    out.push({
      id,
      ready: ready === true,
      ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, 80) } : {}),
    });
  }
  return out;
}

export function isExtAgentName(name: string): boolean {
  return NAME_RE.test(name);
}

interface Entry {
  registry: AgentRegistry;
  /** AgentRegistry의 agent id → 접속 정보. */
  infos: Map<string, ExtAgentInfo>;
}

export class ExtAgentHub {
  private readonly entries = new Map<string, Entry>();

  /**
   * 에이전트가 알림을 남기면 부른다. 알림 저장소는 index.ts가 쥐고 있어 밖에서 꽂는다.
   * 돌려준 id를 에이전트에 알려 준다(notify_ack) — 에이전트는 이걸 받고서야 보낼 목록에서 지운다.
   */
  onNotify: (notice: ExtNotice) => string | undefined = () => undefined;

  /** 접속을 받는다. 이름 검사는 호출자가 먼저 한다. */
  add(agentName: string, deviceName: string, protocol: number, socket: WebSocket): string {
    let entry = this.entries.get(agentName);
    if (!entry) {
      entry = { registry: new AgentRegistry(), infos: new Map() };
      this.entries.set(agentName, entry);
    }
    const agent = entry.registry.add(deviceName, socket);
    const info: ExtAgentInfo = {
      agent: agentName,
      name: deviceName,
      protocol,
      version: '',
      capabilities: [],
      connectedAt: agent.connectedAt,
    };
    entry.infos.set(agent.id, info);

    let window = { count: 0, resetAt: 0 };

    // 요청 응답은 AgentRegistry가 받는다. 여기서는 hello·기능 갱신·알림만 본다.
    socket.on('message', (data) => {
      let msg: { type?: string; version?: unknown; capabilities?: unknown; ref?: unknown; title?: unknown; body?: unknown; kind?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'notify') {
        const ref = typeof msg.ref === 'string' ? msg.ref.slice(0, 64) : undefined;
        const now = Date.now();
        if (now >= window.resetAt) window = { count: 0, resetAt: now + 60_000 };
        const title = typeof msg.title === 'string' ? msg.title.trim() : '';
        let id: string | undefined;
        if (title && ++window.count <= NOTIFY_PER_MINUTE) {
          const kind = msg.kind === 'done' || msg.kind === 'error' ? msg.kind : 'info';
          id = this.onNotify({ agent: agentName, title, body: typeof msg.body === 'string' ? msg.body : '', kind });
        }
        // 받지 못했어도 알린다. 에이전트가 같은 알림을 끝없이 다시 보내지 않게.
        if (ref) socket.send(JSON.stringify({ type: 'notify_ack', ref, ok: id !== undefined, id }));
        return;
      }
      if (msg.type !== 'hello' && msg.type !== 'capabilities') return;
      if (typeof msg.version === 'string') info.version = msg.version.slice(0, 40);
      if ('capabilities' in msg) info.capabilities = sanitizeCapabilities(msg.capabilities);
    });
    socket.on('close', () => entry.infos.delete(agent.id));

    return agent.id;
  }

  /** 이름에 해당하는 레지스트리. 붙은 적이 없으면 없다. */
  registry(agentName: string): AgentRegistry | undefined {
    return this.entries.get(agentName)?.registry;
  }

  list(): ExtAgentInfo[] {
    return [...this.entries.values()].flatMap((e) => [...e.infos.values()]);
  }
}

export const extAgents = new ExtAgentHub();
