import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

/**
 * 접속해 있는 agent-cli들.
 *
 * agent-cli가 공유기 안에 있어도 서버가 먼저 닿을 필요가 없다.
 * 맥 쪽에서 여기로 WebSocket을 열어두고, 서버는 그 연결로 명령을 내려보낸다.
 */

/** 맥으로 보내는 요청. agent-cli가 자기 REST API를 대신 호출해 돌려준다. */
interface PendingRequest {
  resolve: (value: AgentReply) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentReply {
  status: number;
  headers?: Record<string, string>;
  /** JSON 문자열. 파싱은 호출자가 한다. */
  body: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  connectedAt: string;
  /** 마지막으로 신호를 받은 시각. 끊긴 연결을 걸러내는 데 쓴다. */
  lastSeenAt: string;
}

/** 요청 하나가 기다릴 최대 시간. 맥이 답하지 않으면 여기서 끊는다. */
const REQUEST_TIMEOUT_MS = 30_000;

class Agent {
  readonly id = randomUUID();
  readonly connectedAt = new Date().toISOString();
  lastSeenAt = this.connectedAt;

  private readonly pending = new Map<string, PendingRequest>();
  /** SSE처럼 여러 번 나눠 오는 응답의 수신자. */
  private readonly streams = new Map<string, (chunk: string, done: boolean) => void>();

  constructor(
    readonly name: string,
    private readonly socket: WebSocket,
  ) {}

  /** 맥에 요청을 보내고 응답을 기다린다. */
  request(method: string, path: string, body?: string): Promise<AgentReply> {
    const id = randomUUID();
    return new Promise<AgentReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('agent-cli가 응답하지 않습니다.'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'request', id, method, path, body });
    });
  }

  /**
   * 스트림(SSE)을 연다. 청크가 올 때마다 onChunk가 불린다.
   * 반환값을 호출하면 맥 쪽 구독도 함께 끊는다.
   */
  openStream(path: string, onChunk: (chunk: string, done: boolean) => void): () => void {
    const id = randomUUID();
    this.streams.set(id, onChunk);
    this.send({ type: 'stream_open', id, path });

    return () => {
      if (!this.streams.delete(id)) return;
      this.send({ type: 'stream_close', id });
    };
  }

  /** 맥이 보낸 메시지를 처리한다. */
  handle(raw: string): void {
    this.lastSeenAt = new Date().toISOString();

    let msg: {
      type?: string;
      id?: string;
      status?: number;
      body?: string;
      chunk?: string;
      done?: boolean;
      message?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'response' && msg.id) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      clearTimeout(waiting.timer);
      waiting.resolve({ status: msg.status ?? 200, body: msg.body ?? '' });
      return;
    }

    if (msg.type === 'error' && msg.id) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error(msg.message ?? 'agent-cli 오류'));
      return;
    }

    if (msg.type === 'stream_chunk' && msg.id) {
      this.streams.get(msg.id)?.(msg.chunk ?? '', msg.done === true);
      if (msg.done) this.streams.delete(msg.id);
    }
  }

  private send(payload: unknown): void {
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // 연결이 끊겼으면 close 처리에서 정리된다.
    }
  }

  /** 연결이 끊겼을 때 대기 중인 요청을 모두 실패시킨다. */
  dispose(): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('agent-cli 연결이 끊겼습니다.'));
    }
    this.pending.clear();
    for (const onChunk of this.streams.values()) onChunk('', true);
    this.streams.clear();
  }

  info(): AgentInfo {
    return {
      id: this.id,
      name: this.name,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
    };
  }
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  add(name: string, socket: WebSocket): Agent {
    const agent = new Agent(name, socket);
    this.agents.set(agent.id, agent);

    socket.on('message', (data) => agent.handle(data.toString()));
    socket.on('close', () => {
      agent.dispose();
      this.agents.delete(agent.id);
    });
    socket.on('error', () => socket.close());

    return agent;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  /**
   * 기본으로 쓸 agent를 고른다.
   * 대부분 한 대만 붙어 있으므로 지정이 없으면 첫 번째를 쓴다.
   */
  default(): Agent | undefined {
    return this.agents.values().next().value;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((a) => a.info());
  }

  get size(): number {
    return this.agents.size;
  }
}

export const agents = new AgentRegistry();
export type { Agent };
