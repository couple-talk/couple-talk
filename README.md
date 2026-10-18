# couple-talk

커플 둘만 쓰는 작은 데스크톱 메신저입니다. 바탕화면에 내 캐릭터와 상대 캐릭터가 돌아다니면서 상태와 액션(콕 찌르기, 하트, 안아주기)에 반응합니다.
대화는 PC에서 암호화된 뒤 전송되기 때문에 서버 운영자나 중간 네트워크는 내용을 읽을 수 없습니다.

- `app/`: Tauri v2 데스크톱 앱 (Windows, macOS)
- `server/`: 내용을 모르는 중계 서버 (Node, WebSocket, SQLite)

## 보안 모델

- 방을 만들면 32바이트 랜덤 비밀키가 생기고, 이 키가 담긴 **페어링 코드**를 상대에게 직접 전달합니다. 코드는 서버를 거치지 않습니다.
- 비밀키에서 HKDF로 `방 ID`, `서버 인증 토큰`, `AES-256-GCM 암호화 키`를 각각 만듭니다. 서버는 방 ID와 토큰 해시, 암호문만 받습니다.
- 채팅, 상태, 액션은 모두 같은 형태로 암호화되기 때문에 서버는 메시지 종류도 구분하지 못합니다.
- PC에 저장되는 비밀키는 8자 이상의 잠금 비밀번호와 OS 키체인(macOS 키체인, Windows 자격 증명 관리자)에 있는 기기 키를 함께 써서 암호화합니다(PBKDF2 60만 회). 그래서 앱 데이터 폴더만 복사해서는 비밀번호를 맞혀볼 수 없습니다. 키체인을 잃으면(OS 재설치 등) 이 PC를 초기화하고 페어링 코드로 다시 연결하면 됩니다. 평문 대화는 디스크에 쓰지 않습니다.
- 메시지마다 암호문 안에 일회용 값(nonce)이 들어갑니다. 같은 암호문이 다시 와도 지금 불러온 기록(서버 모드는 최근 500개, PC 모드는 최근 5000개) 안에서는 한 번만 표시하고, "각자 PC에만" 모드에서 서버가 메시지를 지우려면 이 값을 받은 수신자의 확인이 필요합니다. 그래서 인증 토큰만 엿본 쪽은 메시지를 지울 수 없습니다.
- 서버 주소는 `wss://`만 허용합니다(로컬 테스트용 `ws://localhost`만 예외).
- 접속 상태와 읽음 표시는 앱이 켜져 있는 동안 10초마다 보내는 신호로 전달됩니다. 신호도 메시지처럼 암호화되고 서버에 저장되지 않으며, 그 순간 접속해 있는 상대에게만 전달됩니다. 서버는 신호가 오가는 시각과 빈도는 알지만 누가 어디까지 읽었는지는 모릅니다.
- 바탕화면 캐릭터 위 말풍선에 메시지 내용이 몇 초간 표시됩니다(최대 40자). 내용은 같은 앱 안의 창끼리만 오가고 네트워크로 나가지 않지만, 옆자리에서 화면이 보일 수 있습니다. 설정에서 "말풍선에 내용 숨기기"를 켜면 💬만 표시되고 내용은 캐릭터 창으로 전달되지 않습니다.
- 직접 가져온 캐릭터 팩도 방 키로 암호화해서 서버에 올립니다(방마다 최대 4개, 각 8MB). 채팅에는 팩의 해시만 오가고, 받는 쪽은 해시와 팩 내용을 다시 검사한 뒤에만 표시합니다. "각자 PC에만" 모드에서는 7일 뒤 서버에서 지웁니다. 받는 쪽은 팩의 압축 해제 크기, 이미지 크기, 포즈·프레임 수를 제한해서 악의적인 팩으로 앱이 멈추지 않게 합니다.

### 막을 수 없는 것

- 화면 캡처, 키로거, DLP 에이전트처럼 PC 자체를 감시하는 프로그램
- "이 PC가 어떤 서버에 언제 접속했는지, 앱을 언제까지 켜 두었는지" 같은 메타데이터
- 회사 방화벽이 서버 도메인을 차단하는 경우
- 페어링 코드가 유출된 경우 (코드를 가진 사람은 대화를 읽을 수 있습니다)
- 서버 운영자가 메시지를 버리거나, 불러온 기록보다 오래된 메시지를 다시 보내는 것 (오래된 메시지는 원래 보낸 시각으로 표시됩니다)
- 두 사람이 같은 닉네임을 쓰면 서로의 메시지를 구분하지 못하고, PC 모드에서 수신 확인도 보내지 않습니다

회사 보안 규정을 지키는지는 사용자 본인이 판단해야 합니다.

## 저장 모드

방을 만들 때 고르며, 나중에 바꿀 수 없습니다.

| 모드 | 서버 | PC |
|---|---|---|
| 서버 | 암호문을 계속 보관합니다. 새 PC에서 코드를 입력하면 기록이 복원됩니다. | 저장하지 않습니다. |
| 각자 PC에만 | 상대가 받으면 바로 삭제하고, 못 받은 메시지도 7일 뒤 삭제합니다. | 받은 암호문을 그대로 보관합니다. PC를 바꾸면 기록은 사라집니다. |

## 서버 직접 띄우기

```sh
cd server
docker build -t couple-talk-server .
docker run -d --restart unless-stopped -p 8080:8080 -v couple-talk-data:/data couple-talk-server
```

TLS는 앞단에 둡니다. `server/Caddyfile`의 도메인을 바꾼 뒤 `caddy run`을 실행하면 인증서가 자동으로 발급됩니다. 앱에서는 서버 주소를 `wss://도메인`으로 입력합니다.
환경변수는 `PORT`(기본 8080), `METRICS_PORT`(기본 9464), `DB_PATH`(기본 `data.db`)입니다. `PORT`는 WebSocket과 상태 확인용 `GET /healthz`만 답하고, 연결 수·방 수·메시지 수 지표(`GET /metrics`, Prometheus 형식)는 `METRICS_PORT`에서만 나갑니다. 지표에 방 ID나 내용은 들어가지 않습니다. `METRICS_PORT`는 외부에 열지 마세요. Docker 없이 실행하려면 Node 22.13 이상에서 `npm ci && npm start`를 실행합니다.

### 맥미니 운영 서버

`wss://couple-talk.tpsg.co.kr`은 맥미니에서 `server/docker-compose.yml`로 떠 있고 Cloudflare 터널이 공개합니다.

- **배포**: `server/`를 바꾼 PR이 `main`에 머지되면 맥미니 self-hosted runner(라벨 `couple-talk-macmini`)에서 `.github/workflows/deploy-server.yml`이 테스트, 이미지 빌드(커밋 SHA 태그), 교체, 터널 너머 `/healthz` 확인까지 합니다. 이미지는 최근 5개만 남깁니다.
- **롤백**: Actions에서 `deploy server`를 수동 실행하고 `sha`에 되돌릴 `main` 커밋의 전체 40자 SHA를 넣습니다. 맥미니에 남아 있는 그 커밋의 이미지를 다시 띄우고, 없으면 빌드합니다. 헬스 체크와 SHA 태그가 생긴 커밋(이 배포 방식을 넣은 PR) 이전으로는 워크플로가 거부하므로 손으로 배포합니다. 이 워크플로는 맥미니 호스트에서 `npm test`를 돌리므로 Node 22.13 이상이 필요합니다.
- **모니터링**: mac-infra의 Prometheus가 `couple-talk-server:9464/metrics`를 수집하고, 서버가 1분 넘게 응답하지 않으면 Alertmanager가 메일을 보냅니다.
- **백업**: DB에는 암호문만 있습니다. 서버를 켠 채로 사본을 만들 수 있습니다.

```sh
docker exec couple-talk-server node -e "new (require('node:sqlite').DatabaseSync)('/data/data.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker cp couple-talk-server:/data/backup.db ./couple-talk-$(date +%F).db
docker exec couple-talk-server rm /data/backup.db
```

복원은 서버를 멈추고 사본을 `data` 볼륨의 `data.db`로 넣은 뒤 다시 띄웁니다.

## 앱 빌드

[Tauri 사전 준비물](https://tauri.app/start/prerequisites/)(Rust 포함)을 설치한 뒤 실행합니다.

```sh
cd app
npm install
npm run tauri dev      # 개발 실행
npm run tauri build    # 설치 파일 생성 (Windows 빌드는 Windows에서)
```

설치 파일은 코드 서명이 되어 있지 않습니다. 처음 실행할 때 Windows는 SmartScreen에서 "추가 정보 → 실행", macOS는 앱을 우클릭한 뒤 "열기"를 선택해야 합니다.
기본 서버 주소는 빌드할 때 `VITE_DEFAULT_SERVER=wss://도메인`으로 지정할 수 있습니다.

## 테스트

```sh
cd server && npm test      # 인증, 브로드캐스트, 히스토리, 로컬 모드 삭제, 신호 중계
cd app && npm run check    # 암복호화 왕복, 다른 키/틀린 비밀번호/키체인 키 없이 거부
cd app/src-tauri && cargo test --lib -- --ignored   # 실제 OS 키체인 저장/재사용 (테스트 전용 항목 사용 후 삭제)
```

브라우저에서도 채팅 화면은 동작합니다(`npm run dev`). 캐릭터 창은 Tauri에서만 동작합니다.

## 캐릭터 팩

앱의 **캐릭터** 버튼에서 팩을 가져오면 상대 화면에도 같은 캐릭터로 보입니다. 이 기능은 서버에 `put`/`get`이 있어야 해서, 예전 서버를 쓰고 있다면 서버도 업데이트해야 합니다. 기본 캐릭터는 `app/public/characters/default/`에 있습니다. 팩은 포즈 그림만 주고 움직임과 효과는 앱이 그려서, ChatGPT 등으로 만든 캐릭터도 똑같이 움직입니다. 필수 포즈, 그림 규칙, 생성 프롬프트는 [docs/character-pack.md](docs/character-pack.md)에 있습니다.

```sh
cd app && npm run check:character -- public/characters/<이름>
```

## 라이선스

AGPL-3.0. 앱 이름과 캐릭터 이미지는 라이선스와 별개로 저작권자에게 있습니다.
