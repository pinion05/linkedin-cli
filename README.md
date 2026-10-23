# linkedin-cli · licli

> **터미널에서 LinkedIn에 글을 올리는 CLI** — 요청을 진짜 Chrome이 날리므로 세션이 죽지 않는다

[![npm](https://img.shields.io/npm/v/@npmc_5/licli)](https://www.npmjs.com/package/@npmc_5/licli)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green)](./package.json)

**English TL;DR** — A LinkedIn posting CLI that drives a *real, isolated Chrome* over CDP. Cookie-based API clients get their session (`li_at`) server-invalidated after a single Voyager call (measured with a full 24-cookie jar + TLS impersonation); requests issued by an actual browser survive. Includes automatic session revival (Google One Tap) and one-line JSON output for AI-agent integration.

---

## 빠른 시작

```bash
bunx @npmc_5/licli post --text "Hello from linkedin-cli 🚀"
```

설치형으로 쓰려면:

```bash
npm install -g @npmc_5/licli   # 명령어: licli / linkedin-cli (동일)
```

로컬 개발: `npm install && npm run build` 후 `node dist/index.js ...`

## 명령어

| 명령 | 동작 |
|---|---|
| `licli post --text "본문"` | 게시 — compose → 입력 → 발행 검증까지 자동 |
| `licli delete --text "본문 일부"` | 내 게시물 텍스트 매칭 → 옵션 메뉴 → "글 삭제" → 확인 |
| `licli status` | 세션 확인 — `li_at` 존재 판정, 죽었으면 자동 재로그인 |
| `licli me` | 프로필 요약 (URL · 이름 · 헤드라인) |
| `licli browser start\|stop\|status` | 격리 브라우저 수명 관리 (보통 자동) |

- 모든 출력은 한 줄 JSON — 에이전트/스크립트 연동에 최적화
- 브라우저가 꺼져 있으면 모든 커맨드가 자동 재기동 (detach 실행이라 CLI 종료와 무관하게 생존)

## 왜 "진짜 브라우저"인가 (2026-10 실측)

LinkedIn은 외부 HTTP 클라이언트를 즉시 죽인다:

- 쿠키 이식(`li_at`+`JSESSIONID`), **풀 쿠키 jar 24개**, curl-impersonate Chrome TLS, UA 정합 — 어떤 조합으로도 **Voyager 호출 1회만 허용되고 li_at이 서버에서 무효화**된다 (측정 완료)
- 심지어 브라우저 세션까지 같이 죽는다

반면 실제 Chrome이 날리는 요청은 차단되지 않는다. 그래서 licli는:

1. **격리 Chrome 인스턴스**(xvfb 가상 디스플레이, 전용 프로필, 포트 9223)를 띄운다 — 여러분이 쓰는 브라우저와 완전 분리
2. UI를 CDP로 조작해 **브라우저 자신이 요청을 발행**하게 한다
3. 세션이 죽어도 LinkedIn 방문만으로 **Google One Tap이 자동 재로그인**한다 (`li_at` 강제 삭제 후 자동 복구됨을 검증)
4. 게시 프로토콜은 SDUI(`/flagship-web/rsc-action` · `sharing.CreatePost`, ShareBox* state binding) — 상태 바인딩이 앱 메모리라 수동 재현 불가, UI 자동화가 유일한 안정 경로

참고: in-page fetch로 Voyager GET을 하려면 csrf-token(`ajax:` 프리픽스 포함)·`x-li-page-instance` 등 앱 헤더가 필요 — 헤더 없으면 403 "CSRF check failed".

## 요구사항

- Linux + Google Chrome + Xvfb (`sudo apt install xvfb`)
- Node ≥ 18
- **최초 1회 프로필 시딩**: LinkedIn에 로그인된 적이 있는 Chrome 프로필을 `~/.local/share/licli/chrome-profile/`로 복사 (캐시 디렉토리 제외 권장). Google 세션이 살아 있으면 이후 재로그인은 전부 자동.

## 구조

- TypeScript 단일 파일 `src/index.ts` → `dist/index.js` (런타임 의존: `ws` 하나)
- `linkedin_cli.py` — 최초 검증용 Python 원본 (참고 유지)
- 원시 CDP: `Runtime.evaluate`(상태 조회·합성 클릭), `Input.insertText`(ProseMirror 입력), `Network.getCookies`(`li_at` 판정 — httpOnly 포함)
- 프로필 경로·포트 오버라이드: `LINKEDIN_CLI_HOME`, `LICLI_PORT`, `LINKEDIN_CLI_ACTIVITY_URL`

## 함정 기록 (기여자용)

LinkedIn 웹 UI 실측 노트 — UI가 바뀌면 여기부터 확인:

- 게시 버튼 텍스트는 **"게시물"** (콘텐츠-유형 드롭다운과 동명 — (y+x) 최대인 우하단 버튼이 발행). "전송"은 메시징 위젯의 숨은 버튼
- 옵션 메뉴 삭제 항목 = **"글 삭제"**, 확인 다이얼로그 버튼 = "삭제"
- **2026-10-23 상호작용 반전**: CDP 신뢰 마우스 입력(`Input.dispatchMouseEvent`)이 메뉴 오픈·에디터 포커스에 무시되게 변경됨 → 합성 `el.click()` / `e.focus()`로 전환 (v0.1.1). 이런 반전은 언제든 다시 일어날 수 있음
- ProseMirror 에디터: `execCommand`·DOM 세팅은 React 상태에 안 잡힘 — `focus()` + `Input.insertText`만 유효
- 좌표-클릭 사이 리플로우로 빗나갈 수 있음 → `scrollIntoView` + 대기-재시도 루프
- 텍스트→카드 매칭은 **버튼에서 카드로 역방향 탐색**(버튼의 조상 카드에 텍스트 있는지)이 가상화된 피드에서 가장 견고 — 리프 텍스트 노드는 분할돼 있을 수 있음

## 주의

개인 계정 자동화는 LinkedIn ToS 그레이존입니다. 저빈도 사용을 권장하며, 사용으로 인한 계정 제약의 책임은 사용자에게 있습니다.

## Changelog

- **0.1.1** — LinkedIn 상호작용 반전 대응: 메뉴/에디터/확인 클릭을 합성 이벤트로 전환
- **0.1.0** — TypeScript 재작성, npm 배포(`@npmc_5/licli`), 전체 사이클 실측 (게시·수정·삭제·세션 자동복구)
