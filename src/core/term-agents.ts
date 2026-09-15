/**
 * 터미널 agent 레지스트리.
 *
 * claudeAgent와 terminal-agent는 하는 일이 달라 따로 관리한다.
 * agents.default()가 늘 첫 번째를 고르기 때문에, 한 목록에 섞으면
 * 둘이 서로를 밀어낸다.
 *
 * 프로토콜은 같으므로 AgentRegistry를 그대로 한 번 더 쓴다.
 * agents.ts는 고치지 않는다.
 */

import { AgentRegistry } from './agents.js';

export const termAgents = new AgentRegistry();
