/**
 * 서버가 들고 있는 자료가 바뀌었음을 구독자에게 알린다.
 *
 * 체크리스트와 알림은 이 서버가 직접 갖는다. 웹에서 할 일을 하나 더하면
 * 안경도 알아야 하는데, 안경은 화면을 옮길 때만 다시 읽었다. 가만히 두면
 * 바뀐 줄 모른다.
 *
 * 무엇이 바뀌었는지만 보낸다. 내용은 구독자가 알아서 다시 읽는다.
 * 그래야 여러 구독자가 각자 필요한 만큼만 가져간다.
 */

/** 바뀐 것의 종류. */
export type Topic = 'checklist' | 'notifications';

type Listener = (topic: Topic) => void;

const listeners = new Set<Listener>();

/** 변화를 구독한다. 반환값을 부르면 끊는다. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 바뀌었다고 알린다.
 *
 * 구독자 하나가 던져도 나머지는 받아야 한다. 끊긴 연결에 쓰다 나는
 * 오류로 다른 구독자까지 막히면 안 된다.
 */
export function publish(topic: Topic): void {
  for (const fn of listeners) {
    try {
      fn(topic);
    } catch {
      // 이 구독자만 건너뛴다.
    }
  }
}

/** 지금 듣고 있는 수. 상태 표시에 쓴다. */
export function subscriberCount(): number {
  return listeners.size;
}
