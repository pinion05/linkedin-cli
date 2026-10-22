# linkedin-cli

LinkedIn 포스팅 CLI — **격리된 실제 Chrome을 HTTP 클라이언트로 쓰는** B-안 설계.

## 왜 이 구조인가 (2026-10-22 실측)

- 이 계정에서 비브라우저(외부 HTTP 클라이언트)의 Voyager API 호출은 **1회만 허용되고 li_at을 서버에서 즉시 무효화**한다. 풀쿠키 24개 + curl-impersonate Chrome TLS + UA 정합 조합으로도 동일 (linkedincli 0.1.6 `--from-chrome` 포함).
- 반면 실제 브라우저가 날리는 요청은 죽지 않는다. Google One Tap이 세션을 자동 부활시킨다.
- 포스팅 프로토콜은 `/flagship-web/rsc-action` SDUI (`com.linkedin.sdui.requests.sharing.CreatePost`, ShareBox* state binding) — 수동 재현 대신 **실제 UI를 CDP로 조작**한다.
- in-page fetch로 Voyager GET을 하려면 csrf-token(+`ajax:` 프리픽스 포함)·x-li-page-instance 등 앱 헤더가 필요 — 헤더 없으면 403 "CSRF check failed".

## 사용

```bash
linkedin-cli browser start        # 격리 크롬 기동 (xvfb, 포트 9223, ~/.local/share/licli/chrome-profile)
linkedin-cli status               # 세션 확인 (li_at 존재 판정; 죽으면 linkedin.com 방문으로 원탭 자동복구)
linkedin-cli me                   # 프로필 요약
linkedin-cli post --text "글"      # 게시 (compose → insertText → 게시물 버튼 → 검증)
linkedin-cli delete --text "글"    # 내 포스트 텍스트 매칭 → 옵션메뉴 → 글 삭제 → 확인
linkedin-cli browser stop
```

브라우저가 꺼져 있으면 모든 커맨드가 자동으로 재기동한다 (detach 실행이라 CLI 종료와 무관하게 생존).

## 구조

- 단일 파일 `linkedin_cli.py` — Python 3 + `websockets`만 의존 (agent-browser 불필요)
- 원시 CDP: `Runtime.evaluate`(좌표획득/검증), `Input.dispatchMouseEvent`(신뢰 클릭 — React 합성 이벤트 무시 우회), `Input.insertText`(ProseMirror 입력), `Network.getCookies`(li_at 판정 — httpOnly 포함)
- 사용 중인 브라우저(9222)와 완전 분리 — 사람이 쓰는 탭을 절대 건드리지 않음
- 프로필은 hermes-clone 복사본에서 시딩됨 (Google 세션 포함 → 원탭 자동복구)

## 함정 기록 (실측)

- React 컴포저의 게시 버튼 텍스트 = **"게시물"** ("게시" 아님; "전송"은 숨은 메시징 버튼)
- 옵션 메뉴의 삭제 항목 = **"글 삭제"** ("삭제" 아님)
- 확인 다이얼로그 버튼 = "삭제"
- 옵션 메뉴/컴포저 트리거는 합성 click() 무시 — 신뢰 입력(Input.dispatch*) 필수
- 좌표-클릭 사이 리플로우로 빗나갈 수 있음 → 클릭 후 요소 대기-재시도 루프
- 피드 가상화로 텍스트 클라임이 컨테이너까지 올라갈 수 있음 → 조상 높이 가드(900px)

## ToS

자동화는 LinkedIn ToS 그레이존 (개인 계정). 저빈도 사용 권장.


## 사용 예시

```bash
$ linkedin-cli status
{"session_ok": true, "port": 9223}

$ linkedin-cli post --text "Hello from linkedin-cli 🚀"
{"ok": true, "detail": "published"}

$ linkedin-cli delete --text "Hello from linkedin-cli"
{"ok": true}
```

## 설치 (Linux)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install websockets
ln -s "$PWD/linkedin_cli.py" ~/.local/bin/linkedin-cli
linkedin-cli browser start   # xvfb + 격리 Chrome 기동 (최초 1회 수동 로그인으로 시딩)
```
