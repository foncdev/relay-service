import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, streamTerminal, type TerminalInfo } from './api.js';

/**
 * 터미널 화면.
 *
 * 맥에서 도는 콘솔과 **같은 셸**을 본다. 한쪽에서 친 명령이 다른 쪽에도
 * 보인다. 구독할 때 그동안의 출력을 먼저 받으므로, 늦게 붙어도 하던
 * 작업이 그대로 보인다.
 *
 * 출력은 SSE로 받고 입력은 POST로 보낸다. WebSocket이 지연은 더 낮지만,
 * 중계 서버가 SSE를 이미 그대로 흘려보내고 있어 경로가 단순하다.
 */
export const TerminalView = memo(TerminalViewInner, (a, b) =>
  // id가 같으면 다시 그릴 이유가 없다. 크기 변화는 내부에서 따로 다룬다.
  a.terminal.id === b.terminal.id && a.onExit === b.onExit,
);

function TerminalViewInner({
  terminal,
  onExit,
}: {
  terminal: TerminalInfo;
  onExit?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const [exited, setExited] = useState(terminal.status === 'exited');
  const [error, setError] = useState('');

  /**
   * 서버가 확정한 셸 크기.
   *
   * 맥 콘솔이 같이 보고 있으면 서버가 더 작은 쪽에 맞춘다. 그때 우리
   * 화면이 자기 크기대로 그리면 vi 같은 전체화면 앱의 마지막 줄이
   * 화면 중간에 찍혀 "아래가 비어 보이는" 상태가 된다.
   * 그래서 화면을 서버 크기에 맞추고, 남는 영역은 따로 표시한다.
   */
  const [shellSize, setShellSize] = useState({ cols: terminal.cols, rows: terminal.rows });
  const [clipped, setClipped] = useState(false);

  // 입력을 모아서 보낸다. 키 하나마다 POST를 날리면 너무 잦다.
  const pendingRef = useRef('');
  const flushTimerRef = useRef<number | null>(null);

  /**
   * 화면을 맞추고 서버에 알린 뒤, 서버가 정한 크기로 되돌린다.
   *
   * fit()은 "이 영역에 몇 칸이 들어가나"를 재는 것이고, 실제 셸 크기는
   * 서버가 정한다. 둘이 다르면 서버 쪽을 따른다.
   */
  const syncSize = useCallback(async () => {
    const term = xtermRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    fit.fit();
    const want = { cols: term.cols, rows: term.rows };

    try {
      const got = await api.resizeTerminal(terminal.id, want.cols, want.rows);
      if (!got?.cols || !got?.rows) return;

      // 같은 값이면 상태를 건드리지 않는다. 리렌더가 잦으면 포커스가 흔들린다.
      setShellSize((cur) =>
        cur.cols === got.cols && cur.rows === got.rows ? cur : { cols: got.cols, rows: got.rows },
      );
      const nowClipped = got.cols !== want.cols || got.rows !== want.rows;
      setClipped((cur) => (cur === nowClipped ? cur : nowClipped));

      // 서버가 더 작게 정했으면 우리 화면도 그만큼만 쓴다.
      if (got.cols !== term.cols || got.rows !== term.rows) {
        term.resize(got.cols, got.rows);
      }
    } catch {
      // 크기 동기화 실패는 치명적이지 않다. 다음 리사이즈에서 다시 맞춘다.
    }
  }, [terminal.id]);

  const flushInput = useCallback(() => {
    const data = pendingRef.current;
    pendingRef.current = '';
    flushTimerRef.current = null;
    if (!data) return;

    api.sendTerminalInput(terminal.id, data).catch(() => {
      setError('입력을 보내지 못했습니다.');
    });
  }, [terminal.id]);

  const queueInput = useCallback(
    (data: string) => {
      pendingRef.current += data;
      if (flushTimerRef.current !== null) return;
      // 8ms면 사람이 못 느끼면서도 연타가 한 번에 묶인다.
      flushTimerRef.current = window.setTimeout(flushInput, 8);
    },
    [flushInput],
  );

  useEffect(() => {
    if (!boxRef.current) return;

    const term = new Xterm({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // 맥 콘솔과 같은 화면을 보므로 스크롤백은 서버가 준 만큼만 쓴다.
      scrollback: 5000,
      // 앱의 다크 테마에 맞춘다(styles.css의 :root 변수와 같은 계열).
      theme: {
        background: '#16161a',
        foreground: '#e6e6ea',
        cursor: '#c96442',
        selectionBackground: '#32323a',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;

    const keySub = term.onData(queueInput);

    // 붙자마자 크기를 맞추고 입력을 받을 준비를 한다.
    void syncSize();
    term.focus();

    const stop = streamTerminal(
      terminal.id,
      (bytes) => term.write(bytes),
      {
        onExit: (code) => {
          setExited(true);
          term.write(`\r\n\x1b[90m[셸이 종료되었습니다 · 코드 ${code}]\x1b[0m\r\n`);
          onExit?.();
        },
        onError: () => setError('연결이 끊겼습니다.'),
      },
    );

    return () => {
      stop();
      keySub.dispose();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushInput();
      }
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [terminal.id, queueInput, flushInput, onExit, syncSize]);

  // 창 크기가 바뀌면 맞춘다. 셸에게도 알려야 화면이 어긋나지 않는다.
  useEffect(() => {
    const onResize = () => void syncSize();

    window.addEventListener('resize', onResize);
    // 탭 전환이나 레이아웃 변화로도 크기가 달라진다.
    const observer = new ResizeObserver(onResize);
    if (boxRef.current) observer.observe(boxRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [terminal.id, syncSize]);

  return (
    <div className="term-wrap">
      {error && <div className="term-error">{error}</div>}
      {exited && !error && <div className="term-exited">셸이 종료되었습니다.</div>}
      {clipped && !error && (
        <div className="term-clipped">
          다른 화면이 더 작아 {shellSize.cols}×{shellSize.rows}로 맞췄습니다. 아래 여백은 셸이 쓰지
          않는 영역입니다.
        </div>
      )}
      {/* 셸이 쓰는 영역만 테두리로 감싼다. 밖은 여백임을 눈으로 알 수 있게.
          여백을 눌러도 입력이 이어지도록 포커스를 xterm으로 넘긴다. */}
      <div
        className={clipped ? 'term-box clipped' : 'term-box'}
        ref={boxRef}
        onMouseDown={() => xtermRef.current?.focus()}
      />
    </div>
  );
}
