# app/

## 창 여러 개가 함께 쓰는 저장소

- 메인 창과 펫 창(`pet`, `pet-me`)은 출처가 같아서 localStorage와 IndexedDB(`ct-packs`, 사진 암호문 `ct-files`)를 함께 쓴다. 초기화(`bindReset`)는 둘 다 지운다.
- IndexedDB 연결은 요청마다 닫는다(`pack.ts`의 `store()`). 한 창이 연결을 열어 두면 다른 창의 `deleteDatabase`가 `blocked`되고, 그 뒤에 오는 `open`도 함께 멈춘다.
- 저장 형식을 바꾸면 이전 빌드가 남긴 데이터를 옮긴다. IndexedDB는 `ct-packs` 버전을 올리고 `onupgradeneeded`에서 한 번만 옮긴다. 렌더할 때마다 채워 넣으면 사용자가 지운 것이 되살아난다.
- `emitTo(label, …)`로 보내는 이벤트는 받는 쪽도 `getCurrentWindow().listen`으로 받는다. 전역 `listen()`은 target이 `Any`라 Tauri 2.12가 `emitTo`의 대상과 상관없이 전달한다(`tauri/src/event/listener.rs` `match_any_or_filter`). 전역 `emit`끼리(`pet-hello`)는 그대로 둔다.
- 페이지를 떠나기 직전(`location.reload()` 등)에 보내는 `petEmit`은 `await`한다. IPC가 끝나기 전에 페이지가 바뀌면 이벤트가 사라진다.

## 펫 창

- 펫 창에서 `win.show()`는 상태가 실제로 바뀔 때만 부른다. macOS에서는 `show()`가 키 창이 되어 메인 창의 포커스를 가져가고, 창 설정의 `focus: false`는 생성할 때만 적용된다.

## 팩 검사

- `checkPack`의 기본값은 상대가 보낸 팩(신뢰할 수 없는 입력) 기준으로 가장 엄격하게 둔다: PNG만, 첫 오류에서 멈춤. 작성자가 쓰는 곳(`character-check.ts`, 내 팩 가져오기)만 `svg`·`all` 옵션으로 넓힌다. 옵션을 빠뜨리면 안전한 쪽으로 동작하게 하기 위해서다.

## 화면 스타일

- 클래스를 붙인 `:hover` 규칙(`button.link:hover` 등)은 `:not(:disabled)`를 함께 쓴다. `button:disabled`보다 명시도가 높아서 비활성 버튼도 눌릴 것처럼 보인다.
- `outline`을 지우는 포커스 규칙은 체크박스·라디오를 뺀다. WKWebView는 이들을 네이티브로 그려서 대신 넣은 `box-shadow` 링이 보이지 않는다.
- 아이콘으로 쓰는 기호 문자는 Windows 기본 폰트에도 있는지 확인한다. `⏻`(U+23FB)은 macOS 시스템 폰트에만 있고 Segoe UI Symbol에는 없어 네모로 나온다. 컬러 이모지가 안전하다.

## 사람 구분 (#7)

- 내 메시지인지는 `sentBy()`로만 판단한다. `p`가 없는 메시지(#7 이전, 예전 앱)는 닉네임으로 판단하므로, 내 설정을 새 PC로 옮기는 경로는 사람 ID와 함께 `pastNicks`까지 옮긴다.
- 상대 이름표(`ct.partner`)는 마지막으로 받은 메시지의 닉네임을 쓴다. 사람 ID별로 처음 본 이름을 고정하면 상대가 이름을 바꿔도 반영되지 않는다.
