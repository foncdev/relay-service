/**
 * 관리 UI(/web)에 뜨는 글의 한국어·영어 판.
 *
 * 언어는 브라우저의 navigator.languages를 따른다. 첫 언어가 ko로 시작하면
 * 한국어, 그 밖은 모두 영어다. 안경(glasses-ui/src/core/i18n.ts)·폰 앱과
 * 같은 규칙이다.
 *
 * 개발할 때는 주소에 ?lang=en|ko를 붙여 바꿔 본다. 고른 값은 브라우저에
 * 남으므로 ?lang=auto로 되돌린다.
 *
 * 서버에서 온 자료(할 일, 알림 제목·본문, 세션 이름, 명령 출력, 서버 오류
 * 메시지)는 옮기지 않는다. 서버가 RELAY_LANG에 맞춰 이미 옮겨 보낸다.
 * 여기는 이 화면이 스스로 만드는 글만 둔다.
 *
 * 언어 추가: Locale에 코드를 더하고, Messages 타입을 만족하는 판을
 * CATALOGS에 넣은 뒤 detectLocale에 고르는 규칙을 더한다. 키가 빠지거나
 * 남으면 타입 검사와 relay-service/test/web-i18n.test.ts가 잡는다.
 *
 * DOM 없이도 읽힌다(테스트가 node에서 불러온다). navigator·document·
 * localStorage는 있을 때만 쓴다.
 */

export type Locale = 'ko' | 'en';

export const LOCALES: readonly Locale[] = ['ko', 'en'];

/** 날짜·시각을 찍을 때 Intl에 넘기는 태그. */
const INTL_TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en' };

/** ?lang= 로 고른 값을 두는 곳. */
const LANG_STORAGE = 'relay.web.lang';

const ko = {
  // --- 공통 ---
  appTitle: 'Claude Code 매니저',
  tagline: 'Claude Code 원격 제어',
  cancel: '취소',
  ok: '확인',
  close: '닫기',
  add: '추가',
  save: '저장',
  delete: '삭제',
  rename: '이름 변경',
  renameAction: '변경',
  create: '만들기',
  loading: '불러오는 중…',
  refresh: '새로고침',
  newChat: '새 대화',
  unknown: '(확인 불가)',
  /** 로그인 토큰에 붙는 기기 이름. 토큰 목록에 보인다. */
  deviceLabel: '웹',

  // --- 로그인 ---
  cannotReachServer: '서버에 연결할 수 없습니다.',
  connecting: '연결 중…',
  passwordMismatch: '비밀번호가 서로 다릅니다.',
  failed: '실패했습니다.',
  setupTitle: '초기 설정',
  signIn: '로그인',
  setupHint:
    '관리자 계정을 만듭니다. 서버 시작 로그에 찍힌 설정 코드가 필요합니다. 이 계정으로 에이전트를 제어하므로 비밀번호를 신중히 정하세요.',
  signInHint:
    'relay-service 관리자 계정으로 로그인합니다. G2 안경은 이 계정이 아니라 폰 Glass Relay 앱의 접속 키로 들어갑니다.',
  setupCode: '설정 코드',
  setupCodePlaceholder: '서버 로그의 XXXX-XXXX-XXXX',
  username: '아이디',
  usernamePlaceholder: '영문/숫자 3~32자',
  password: '비밀번호',
  passwordPlaceholder: '10자 이상',
  passwordConfirm: '비밀번호 확인',
  working: '처리 중…',
  createAccount: '계정 만들기',

  // --- 위쪽 막대 ---
  tabSessions: '세션',
  tabFiles: '파일',
  tabTerminal: '터미널',
  tabTodos: '할 일',
  tabNotifications: '알림',
  tabMonitor: '모니터링',

  // --- 모니터링 ---
  monStatus: '상태',
  monSettings: '설정',
  monRefresh: '새로 읽기',
  monProblem: '문제',
  monWarn: '주의',
  monOk: '정상',
  monNoData: '값 없음',
  monCrit: '위험',
  monServices: (up: number, total: number) => `서비스 ${up}/${total}`,
  monAsOf: (t: string) => `${t} 기준`,
  monStale: '읽기 실패 — 이전 값을 보이고 있습니다',
  monOff: '모니터링이 꺼져 있습니다. 설정에서 Grafana 주소를 넣거나 가짜 데이터로 켜세요.',
  monLoading: '읽는 중…',
  monEmpty: '대상이 없습니다. 쿼리 결과가 비었는지 설정에서 연결 시험으로 확인하세요.',
  monSource: (s: string) => `원천: ${s}`,
  monConnection: '연결',
  monMode: '원천',
  monModeGrafana: 'Grafana',
  monModeDemo: '가짜 데이터(화면 확인용)',
  monModeOff: '끔',
  monUrl: 'Grafana 주소',
  monToken: '서비스 계정 토큰',
  monTokenHint: 'Viewer 권한이면 됩니다. 이 서버에만 두고 안경·폰에는 보내지 않습니다.',
  monTokenSaved: '저장됨 — 바꿀 때만 입력',
  monTokenEnv: '환경변수(GRAFANA_TOKEN)로 정함',
  monTokenClear: '저장한 토큰 지우기',
  monDatasource: '데이터 소스 UID',
  monDatasourceHint: '비우면 기본 Prometheus를 씁니다. 연결 시험을 하면 고를 수 있습니다.',
  monRefreshSeconds: '읽는 주기(초)',
  monLocked: '환경변수로 정함 — .env에서 바꿉니다',
  monGrouping: '서버 묶기',
  monServerLabel: '서버를 가르는 라벨',
  monStripPort: '라벨 값의 :포트를 뗀다 (web-01:9100 → web-01)',
  monGroupLabel: '그룹을 가르는 라벨',
  monGroupsText: '그룹 직접 정하기',
  monGroupsHint: '한 줄에 하나: 그룹 이름 = 서버 이름 패턴, 패턴 (* 가능). 여기 적은 것이 라벨보다 먼저입니다.',
  monMetrics: '서버 지표',
  monMetricsHint: '결과 시계열마다 서버 라벨로 서버를 가릅니다. 기준 이상이면 주의·위험(낮을수록 나쁨이면 이하).',
  monStats: '업무 지표',
  monStatsHint: '서버가 아닌 값(오늘 주문·반품 등). 그룹·대상을 직접 적고, 값 하나를 읽습니다. SQL 데이터 소스면 SQL을 적습니다.',
  monServicesSection: '서비스 UP/DOWN',
  monServicesQuery: '쿼리 (값이 1이면 UP, 비우면 끔)',
  monServicesName: '서비스 이름 라벨',
  monKey: '키',
  monLabel: '이름',
  monQuery: '쿼리 (PromQL)',
  monSql: 'SQL',
  monUseSql: 'SQL로 읽기',
  monUnit: '단위',
  monMax: '최대',
  monWarnAt: '주의',
  monCritAt: '위험',
  monLowerIsWorse: '낮을수록 나쁨',
  monGroup: '그룹',
  monItem: '대상',
  monAddMetric: '지표 추가',
  monAddStat: '업무 지표 추가',
  monResetMetrics: '기본 지표로',
  monRemove: '빼기',
  monTest: '연결 시험',
  monTesting: '시험 중…',
  monSave: '저장',
  monSaved: '저장했습니다. 바로 다시 읽습니다.',
  monReload: '되돌리기',
  monTestOk: (groups: number, items: number) => `읽었습니다 — 그룹 ${groups}개, 대상 ${items}개`,
  monTestFail: '읽지 못했습니다',
  monPickDatasource: '서버 지표에 쓰기',
  monDatasourcePicked: '사용 중',
  monDatasourceSet: (uid: string) => `데이터 소스를 ${uid}(으)로 정했습니다. 저장하면 반영됩니다.`,
  monDatasourceForStats: '업무 지표의 데이터 소스 UID에 넣어 씁니다',
  monFiles: (file: string) => `웹에서 저장한 설정: ${file}`,
  workspace: '워크스페이스',
  noWorkspaces: '워크스페이스 없음',
  addWorkspace: '워크스페이스 추가',
  settings: '설정',
  signOut: '로그아웃',
  signOutAs: (user: string) => `${user} — 로그아웃`,

  // --- 세션 ---
  sessions: '세션',
  newSession: '새 세션',
  noSessions: '세션이 없습니다.',
  closeSession: '세션 종료',
  resumeChat: '대화 이어가기',
  deleteHistory: '기록 삭제',
  pickOrCreateSession: '세션을 선택하거나 새로 만드세요.',
  addWorkspaceFirst: '먼저 워크스페이스를 추가하세요.',
  loadWorkspacesFailed: '워크스페이스 조회 실패',
  closeFailed: '종료 실패',
  deleteFailed: '삭제 실패',
  resumeFailed: '이어가기 실패',
  renameFailed: '이름 변경 실패',
  resumed: '대화를 이어갑니다.',
  resumedDeleted: '대화를 이어갑니다. 원본 기록은 삭제했습니다.',
  renameSession: '세션 이름 변경',
  name: '이름',
  sessionName: '세션 이름',
  closeSessionQ: (title: string) => `"${title}" 세션을 종료할까요?\n대화 기록은 남습니다.`,
  deleteHistoryQ: (title: string) => `"${title}" 의 대화 기록을 완전히 삭제할까요?\n되돌릴 수 없습니다.`,
  closeAction: '종료',

  // --- 워크스페이스 추가 ---
  idHint: '영문/숫자/밑줄/하이픈',
  path: '경로',
  allowedRoots: (roots: string) => `허용 루트: ${roots}`,
  registerFailed: '등록 실패',

  // --- 새 세션 ---
  createSessionFailed: '세션 생성 실패',
  location: '작업 위치',
  enterPath: '경로 직접 입력',
  fullPath: '전체 경로',
  pathHint: '~ 사용 가능. 처음 쓰는 경로는 워크스페이스로 자동 등록됩니다.',
  subPath: '하위 경로 (선택)',
  model: '모델 (선택)',
  modelPlaceholder: '비워두면 기본값',
  policy: '권한 정책',
  policyAskRisky: '위험한 작업만 확인',
  policyAskAll: '모두 확인',
  policyAutoApprove: '전부 자동 승인',
  starting: '시작하는 중…',
  start: '시작',

  // --- 설정 ---
  legacyApiKey: '예전 API 키 (선택)',
  legacyApiKeyPlaceholder: '서버의 AGENT_API_KEY',
  legacyApiKeyHint:
    '계정으로 로그인했으면 비워 두세요. 계정이 생기기 전의 방식(AGENT_API_KEY)을 쓰는 서버와 맞추려고 남겨 둔 칸입니다. 브라우저에만 저장됩니다.',
  deleteOnResume: '이어가기 후 원본 기록 삭제',
  deleteOnResumeWarn: '⚠ 이어간 뒤 원본 대화 기록이 영구 삭제됩니다. 되돌릴 수 없습니다.',
  deleteOnResumeOff: '목록에 원본이 함께 남습니다 (기본).',

  // --- 대화 ---
  allowed: '허용',
  denied: '거부',
  auto: ' (자동)',
  sessionClosed: '세션이 종료되었습니다.',
  resumedHere: '── 여기부터 이어서 대화합니다 ──',
  sendFailed: '전송 실패',
  permissionFailed: '권한 처리 실패',
  policyFailed: '정책 변경 실패',
  turns: (n: number) => `${n}턴`,
  todoList: '할 일 목록',
  todos: '할 일',
  startPrompt: '프롬프트를 입력해 대화를 시작하세요.',
  noHistory: '기록된 대화가 없습니다.',
  me: '나',
  permissionRequest: (tool: string) => `권한 요청: ${tool}`,
  allow: '허용',
  deny: '거부',
  promptPlaceholder: '프롬프트를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)',
  send: '전송',
  sessionEnded: '종료된 세션입니다.',
  resuming: '이어가는 중…',
  resumeButton: '▶ 대화 이어가기',

  // --- 할 일 ---
  addFailed: '추가 실패',
  changeFailed: '변경 실패',
  editFailed: '수정 실패',
  clearFailed: '정리 실패',
  reorderFailed: '순서 변경 실패',
  cleared: (n: number) => `${n}개 정리했습니다.`,
  allTodos: '전역 할 일',
  clearCompleted: '완료 정리',
  clearCompletedTitle: '완료 항목 정리',
  noTodos: '할 일이 없습니다.',
  multiLineHint: '여러 줄을 넣으면 줄마다 항목이 됩니다.',
  dragToReorder: '끌어서 순서 바꾸기 (↑↓)',
  reorderItem: (text: string) => `순서 바꾸기: ${text}`,
  doubleClickToEdit: '더블클릭하면 수정',
  todoPlaceholder: '할 일 입력 (Enter 추가, Shift+Enter 줄바꿈)',

  // --- 알림 ---
  notifications: '알림',
  addNotificationFailed: '알림 추가 실패',
  actionFailed: '처리 실패',
  markAllRead: '모두 읽음',
  clearRead: '읽음 정리',
  clearReadTitle: '읽은 알림 정리',
  noNotifications: '알림이 없습니다.',
  notificationPlaceholder: '알림 내용 (첫 줄이 제목, Enter 추가, Shift+Enter 줄바꿈)',

  // --- 파일 ---
  listFailed: '목록 조회 실패',
  openFileFailed: '파일 열기 실패',
  saved: '저장했습니다.',
  saveFailed: '저장 실패',
  deleted: '삭제했습니다.',
  newFile: '새 파일',
  newFolder: '새 폴더',
  newFileButton: '＋파일',
  newFolderButton: '＋폴더',
  showHidden: '숨김 파일 표시',
  hidden: '숨김',
  empty: '비어 있습니다.',
  modified: '수정됨',
  download: '다운로드',
  revert: '되돌리기',
  pickFile: '왼쪽에서 파일을 선택하세요.',
  fileName: '파일 이름',
  folderName: '폴더 이름',
  currentPath: (dir: string) => `현재 경로: /${dir}`,
  createFailed: '생성 실패',
  newName: '새 이름',
  deleteEntryQ: (isDir: boolean, name: string) =>
    `${isDir ? '디렉토리' : '파일'} "${name}"을(를) 삭제할까요?${
      isDir ? '\n안에 든 내용도 함께 삭제됩니다.' : ''
    }\n되돌릴 수 없습니다.`,

  // --- 터미널 ---
  noTerminalAgent: '맥에서 terminal-agent가 실행 중이 아닙니다.',
  loadTerminalsFailed: '터미널 목록을 불러오지 못했습니다.',
  terminalOpened: '터미널을 열었습니다.',
  openTerminalFailed: '터미널을 열지 못했습니다.',
  terminalClosed: '터미널을 닫았습니다.',
  closeTerminalFailed: '닫지 못했습니다.',
  disconnected: '연결이 끊어졌습니다.',
  /** 앞·가운데·뒤 사이에 <code>exit</code>, <code>ctrl+\</code>가 들어간다. */
  disconnectedWhy: ['맥 콘솔에서 ', ' 하거나 ', ' 로 나가면 terminal-agent가 함께 종료됩니다. 웹에서 계속 쓰시려면 맥 콘솔을 켜둔 채로 두세요.'] as readonly string[],
  restartOnMac: '맥에서 다시 시작:',
  reconnect: '다시 연결',
  newTerminal: '+ 새 터미널',
  noTerminals: '열린 터미널이 없습니다.',
  openTerminal: '새 터미널 열기',
  closeTerminal: '터미널 닫기',
  closeTerminalQ: (dir: string) => `${dir} 의 셸을 끝냅니다. 실행 중인 작업이 있으면 함께 중단됩니다.`,
  inputFailed: '입력을 보내지 못했습니다.',
  shellExitedCode: (code: number) => `[셸이 종료되었습니다 · 코드 ${code}]`,
  connectionLost: '연결이 끊겼습니다.',
  shellExited: '셸이 종료되었습니다.',
  clipped: (cols: number, rows: number) =>
    `다른 화면이 더 작아 ${cols}×${rows}로 맞췄습니다. 아래 여백은 셸이 쓰지 않는 영역입니다.`,

  // --- 기타 ---
  requestFailed: (status: number) => `요청 실패 (${status})`,
};

/**
 * 판 하나의 모양. 한국어 판에서 뽑되, 글은 string으로 넓힌다.
 * 영어 판이 키를 빠뜨리거나 더하면 타입 검사에서 걸린다.
 */
export type Messages = {
  readonly [K in keyof typeof ko]: (typeof ko)[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : (typeof ko)[K] extends readonly string[]
      ? readonly string[]
      : string;
};

const en: Messages = {
  appTitle: 'Claude Code Manager',
  tagline: 'Claude Code remote control',
  cancel: 'Cancel',
  ok: 'OK',
  close: 'Close',
  add: 'Add',
  save: 'Save',
  delete: 'Delete',
  rename: 'Rename',
  renameAction: 'Rename',
  create: 'Create',
  loading: 'Loading…',
  refresh: 'Refresh',
  newChat: 'New chat',
  unknown: '(unknown)',
  deviceLabel: 'Web',

  cannotReachServer: 'Cannot reach the server.',
  connecting: 'Connecting…',
  passwordMismatch: 'Passwords do not match.',
  failed: 'Something went wrong.',
  setupTitle: 'Initial Setup',
  signIn: 'Sign In',
  setupHint:
    'Create the admin account. You need the setup code printed in the server startup log. This account controls your agents, so choose the password carefully.',
  signInHint:
    'Sign in with the relay-service admin account. G2 glasses do not use this account; they sign in with the Access Key from the Glass Relay app on your phone.',
  setupCode: 'Setup code',
  setupCodePlaceholder: 'XXXX-XXXX-XXXX from the server log',
  username: 'Username',
  usernamePlaceholder: '3–32 letters or digits',
  password: 'Password',
  passwordPlaceholder: 'At least 10 characters',
  passwordConfirm: 'Confirm password',
  working: 'Working…',
  createAccount: 'Create Account',

  tabSessions: 'Sessions',
  tabFiles: 'Files',
  tabTerminal: 'Terminal',
  tabTodos: 'To-Dos',
  tabNotifications: 'Notifications',
  tabMonitor: 'Monitoring',

  monStatus: 'Status',
  monSettings: 'Settings',
  monRefresh: 'Refresh',
  monProblem: 'Problem',
  monWarn: 'Warning',
  monOk: 'OK',
  monNoData: 'No data',
  monCrit: 'Critical',
  monServices: (up, total) => `Services ${up}/${total}`,
  monAsOf: (t) => `as of ${t}`,
  monStale: 'Read failed — showing the previous values',
  monOff: 'Monitoring is off. Enter a Grafana URL in Settings, or turn on demo data.',
  monLoading: 'Loading…',
  monEmpty: 'No targets. Use Test connection in Settings to see whether the queries return anything.',
  monSource: (s) => `Source: ${s}`,
  monConnection: 'Connection',
  monMode: 'Source',
  monModeGrafana: 'Grafana',
  monModeDemo: 'Demo data (to preview screens)',
  monModeOff: 'Off',
  monUrl: 'Grafana URL',
  monToken: 'Service account token',
  monTokenHint: 'Viewer role is enough. Kept on this server only, never sent to the glasses or phone.',
  monTokenSaved: 'Saved — enter only to change',
  monTokenEnv: 'Set by environment variable (GRAFANA_TOKEN)',
  monTokenClear: 'Remove saved token',
  monDatasource: 'Data source UID',
  monDatasourceHint: 'Leave empty to use the default Prometheus. Test connection lets you pick one.',
  monRefreshSeconds: 'Refresh interval (s)',
  monLocked: 'Set by environment variable — change it in .env',
  monGrouping: 'Grouping',
  monServerLabel: 'Server label',
  monStripPort: 'Strip :port from the label value (web-01:9100 → web-01)',
  monGroupLabel: 'Group label',
  monGroupsText: 'Groups by name',
  monGroupsHint: 'One per line: group name = server name pattern, pattern (* allowed). These win over the label.',
  monMetrics: 'Server metrics',
  monMetricsHint: 'Each result series is matched to a server by the server label. At or above a threshold is warning/critical (at or below if lower is worse).',
  monStats: 'Business metrics',
  monStatsHint: 'Values that are not servers (orders, returns today…). Set the group and target, read one value. Use SQL for SQL data sources.',
  monServicesSection: 'Services UP/DOWN',
  monServicesQuery: 'Query (1 means UP, empty turns it off)',
  monServicesName: 'Service name label',
  monKey: 'Key',
  monLabel: 'Name',
  monQuery: 'Query (PromQL)',
  monSql: 'SQL',
  monUseSql: 'Read with SQL',
  monUnit: 'Unit',
  monMax: 'Max',
  monWarnAt: 'Warn',
  monCritAt: 'Crit',
  monLowerIsWorse: 'Lower is worse',
  monGroup: 'Group',
  monItem: 'Target',
  monAddMetric: 'Add metric',
  monAddStat: 'Add business metric',
  monResetMetrics: 'Default metrics',
  monRemove: 'Remove',
  monTest: 'Test connection',
  monTesting: 'Testing…',
  monSave: 'Save',
  monSaved: 'Saved. Reading again now.',
  monReload: 'Revert',
  monTestOk: (groups, items) => `Read ${groups} groups, ${items} targets`,
  monTestFail: 'Could not read',
  monPickDatasource: 'Use for server metrics',
  monDatasourcePicked: 'In use',
  monDatasourceSet: (uid) => `Data source set to ${uid}. Save to apply.`,
  monDatasourceForStats: 'Use it in a business metric\'s data source UID',
  monFiles: (file) => `Settings saved from the web: ${file}`,
  workspace: 'Workspace',
  noWorkspaces: 'No workspaces',
  addWorkspace: 'Add workspace',
  settings: 'Settings',
  signOut: 'Sign Out',
  signOutAs: (user) => `${user} — Sign Out`,

  sessions: 'Sessions',
  newSession: 'New Session',
  noSessions: 'No sessions.',
  closeSession: 'End session',
  resumeChat: 'Resume chat',
  deleteHistory: 'Delete history',
  pickOrCreateSession: 'Select a session or start a new one.',
  addWorkspaceFirst: 'Add a workspace first.',
  loadWorkspacesFailed: 'Could not load workspaces',
  closeFailed: 'Could not end the session',
  deleteFailed: 'Could not delete',
  resumeFailed: 'Could not resume',
  renameFailed: 'Could not rename',
  resumed: 'Resuming the chat.',
  resumedDeleted: 'Resuming the chat. The original history was deleted.',
  renameSession: 'Rename Session',
  name: 'Name',
  sessionName: 'Session name',
  closeSessionQ: (title) => `End the session "${title}"?\nThe chat history is kept.`,
  deleteHistoryQ: (title) => `Permanently delete the chat history of "${title}"?\nThis cannot be undone.`,
  closeAction: 'End',

  idHint: 'Letters, digits, underscores, hyphens',
  path: 'Path',
  allowedRoots: (roots) => `Allowed roots: ${roots}`,
  registerFailed: 'Could not add',

  createSessionFailed: 'Could not start the session',
  location: 'Location',
  enterPath: 'Enter a path',
  fullPath: 'Full path',
  pathHint: '~ is allowed. A new path is added as a workspace automatically.',
  subPath: 'Subpath (optional)',
  model: 'Model (optional)',
  modelPlaceholder: 'Leave empty for the default',
  policy: 'Permission policy',
  policyAskRisky: 'Ask for risky actions only',
  policyAskAll: 'Ask for everything',
  policyAutoApprove: 'Approve everything',
  starting: 'Starting…',
  start: 'Start',

  legacyApiKey: 'Legacy API key (optional)',
  legacyApiKeyPlaceholder: 'The server’s AGENT_API_KEY',
  legacyApiKeyHint:
    'Leave empty if you signed in with an account. This field is kept for servers that still use the pre-account AGENT_API_KEY. Stored in this browser only.',
  deleteOnResume: 'Delete the original history after resuming',
  deleteOnResumeWarn: '⚠ The original chat history is permanently deleted after resuming. This cannot be undone.',
  deleteOnResumeOff: 'The original stays in the list (default).',

  allowed: 'allowed',
  denied: 'denied',
  auto: ' (auto)',
  sessionClosed: 'The session has ended.',
  resumedHere: '── Resumed from here ──',
  sendFailed: 'Could not send',
  permissionFailed: 'Could not answer the permission request',
  policyFailed: 'Could not change the policy',
  turns: (n) => (n === 1 ? '1 turn' : `${n} turns`),
  todoList: 'To-do list',
  todos: 'To-Dos',
  startPrompt: 'Type a prompt to start the chat.',
  noHistory: 'No chat history.',
  me: 'Me',
  permissionRequest: (tool) => `Permission request: ${tool}`,
  allow: 'Allow',
  deny: 'Deny',
  promptPlaceholder: 'Type a prompt (Enter to send, Shift+Enter for a new line)',
  send: 'Send',
  sessionEnded: 'This session has ended.',
  resuming: 'Resuming…',
  resumeButton: '▶ Resume Chat',

  addFailed: 'Could not add',
  changeFailed: 'Could not update',
  editFailed: 'Could not edit',
  clearFailed: 'Could not clear',
  reorderFailed: 'Could not reorder',
  cleared: (n) => (n === 1 ? 'Cleared 1 item.' : `Cleared ${n} items.`),
  allTodos: 'All To-Dos',
  clearCompleted: 'Clear Completed',
  clearCompletedTitle: 'Clear completed items',
  noTodos: 'No to-dos.',
  multiLineHint: 'Each line becomes its own item.',
  dragToReorder: 'Drag to reorder (↑↓)',
  reorderItem: (text) => `Reorder: ${text}`,
  doubleClickToEdit: 'Double-click to edit',
  todoPlaceholder: 'Add a to-do (Enter to add, Shift+Enter for a new line)',

  notifications: 'Notifications',
  addNotificationFailed: 'Could not add the notification',
  actionFailed: 'Something went wrong',
  markAllRead: 'Mark All Read',
  clearRead: 'Clear Read',
  clearReadTitle: 'Clear read notifications',
  noNotifications: 'No notifications.',
  notificationPlaceholder: 'Notification (first line is the title, Enter to add, Shift+Enter for a new line)',

  listFailed: 'Could not load the list',
  openFileFailed: 'Could not open the file',
  saved: 'Saved.',
  saveFailed: 'Could not save',
  deleted: 'Deleted.',
  newFile: 'New File',
  newFolder: 'New Folder',
  newFileButton: '＋File',
  newFolderButton: '＋Folder',
  showHidden: 'Show hidden files',
  hidden: 'Hidden',
  empty: 'Empty.',
  modified: 'Modified',
  download: 'Download',
  revert: 'Revert',
  pickFile: 'Select a file on the left.',
  fileName: 'File name',
  folderName: 'Folder name',
  currentPath: (dir) => `Current path: /${dir}`,
  createFailed: 'Could not create',
  newName: 'New name',
  deleteEntryQ: (isDir, name) =>
    `Delete the ${isDir ? 'folder' : 'file'} "${name}"?${
      isDir ? '\nEverything inside it is deleted too.' : ''
    }\nThis cannot be undone.`,

  noTerminalAgent: 'terminal-agent is not running on the Mac.',
  loadTerminalsFailed: 'Could not load terminals.',
  terminalOpened: 'Terminal opened.',
  openTerminalFailed: 'Could not open a terminal.',
  terminalClosed: 'Terminal closed.',
  closeTerminalFailed: 'Could not close it.',
  disconnected: 'Disconnected.',
  disconnectedWhy: ['Leaving the Mac console with ', ' or ', ' also stops terminal-agent. To keep using it from the web, leave the Mac console running.'],
  restartOnMac: 'Restart on the Mac:',
  reconnect: 'Reconnect',
  newTerminal: '+ New Terminal',
  noTerminals: 'No open terminals.',
  openTerminal: 'Open a Terminal',
  closeTerminal: 'Close Terminal',
  closeTerminalQ: (dir) => `This ends the shell in ${dir}. Anything running in it stops too.`,
  inputFailed: 'Could not send input.',
  shellExitedCode: (code) => `[Shell exited · code ${code}]`,
  connectionLost: 'Connection lost.',
  shellExited: 'The shell has exited.',
  clipped: (cols, rows) =>
    `Fitted to ${cols}×${rows} because another screen is smaller. The space below is not used by the shell.`,

  requestFailed: (status) => `Request failed (${status})`,
};

export const CATALOGS: Readonly<Record<Locale, Messages>> = { ko, en };

/** 브라우저 언어 목록에서 판을 고른다. 첫 언어가 ko로 시작하면 한국어, 나머지는 영어. */
export function detectLocale(languages: readonly string[] | undefined | null): Locale {
  const first = languages?.find((l) => typeof l === 'string' && l.length > 0);
  return first?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** 'en', 'ko-KR' 같은 값을 판 코드로. 알 수 없으면 null. */
function parseLocale(value: string | null | undefined): Locale | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('ko')) return 'ko';
  if (v.startsWith('en')) return 'en';
  return null;
}

function readStorage(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LANG_STORAGE);
  } catch {
    return null;
  }
}

function writeStorage(value: Locale | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value) localStorage.setItem(LANG_STORAGE, value);
    else localStorage.removeItem(LANG_STORAGE);
  } catch {
    // 저장 못 해도 이번 화면에는 적용된다.
  }
}

/**
 * 쓸 판을 정한다. ?lang= > 저장해 둔 값 > 브라우저 언어 순서다.
 * ?lang=en|ko는 저장해서 다음에도 쓰고, ?lang=auto는 지운다.
 */
export function resolveLocale(): Locale {
  let query: string | null = null;
  try {
    if (typeof location !== 'undefined') query = new URLSearchParams(location.search).get('lang');
  } catch {
    query = null;
  }
  if (query !== null) {
    const picked = parseLocale(query);
    writeStorage(picked);
    if (picked) return picked;
  } else {
    const stored = parseLocale(readStorage());
    if (stored) return stored;
  }

  if (typeof navigator === 'undefined') return 'en';
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLocale(langs);
}

let current: Locale = resolveLocale();

export function locale(): Locale {
  return current;
}

/** 테스트용. 화면에서는 새로고침해야 반영된다. */
export function setLocale(value: Locale): void {
  current = value;
}

/** 지금 판. */
export function msg(): Messages {
  return CATALOGS[current];
}

/** <html lang>과 창 제목을 지금 언어로 맞춘다. 시작할 때 한 번 부른다. */
export function applyDocumentLocale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.title = msg().appTitle;
}

/** '3분 전', '3 min. ago'. 하루가 넘으면 날짜(월·일)로. */
export function formatRelative(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  const tag = INTL_TAG[current];
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
  if (diff < 60_000) return rtf.format(0, 'second');
  if (diff < 3600_000) return rtf.format(-Math.floor(diff / 60_000), 'minute');
  if (diff < 86400_000) return rtf.format(-Math.floor(diff / 3600_000), 'hour');
  return d.toLocaleDateString(tag, { month: 'numeric', day: 'numeric' });
}

/** 날짜와 시각. 24시간제. 잘못된 값이면 빈 글. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(INTL_TAG[current], { hour12: false });
}
