# app/

## 창 여러 개가 함께 쓰는 저장소

- 메인 창과 펫 창(`pet`, `pet-me`)은 출처가 같아서 localStorage와 IndexedDB(`ct-packs`)를 함께 쓴다.
- IndexedDB 연결은 요청마다 닫는다(`pack.ts`의 `store()`). 한 창이 연결을 열어 두면 다른 창의 `deleteDatabase`가 `blocked`되고, 그 뒤에 오는 `open`도 함께 멈춘다.
- `emitTo(label, …)`로 보내는 이벤트는 받는 쪽도 `getCurrentWindow().listen`으로 받는다. 전역 `listen()`은 target이 `Any`라 Tauri 2.12가 `emitTo`의 대상과 상관없이 전달한다(`tauri/src/event/listener.rs` `match_any_or_filter`). 전역 `emit`끼리(`pet-hello`)는 그대로 둔다.
- 페이지를 떠나기 직전(`location.reload()` 등)에 보내는 `petEmit`은 `await`한다. IPC가 끝나기 전에 페이지가 바뀌면 이벤트가 사라진다.

## 펫 창

- 펫 창에서 `win.show()`는 상태가 실제로 바뀔 때만 부른다. macOS에서는 `show()`가 키 창이 되어 메인 창의 포커스를 가져가고, 창 설정의 `focus: false`는 생성할 때만 적용된다.

## 팩 검사

- `checkPack`의 기본값은 상대가 보낸 팩(신뢰할 수 없는 입력) 기준으로 가장 엄격하게 둔다: PNG만, 첫 오류에서 멈춤. 작성자가 쓰는 곳(`character-check.ts`, 내 팩 가져오기)만 `svg`·`all` 옵션으로 넓힌다. 옵션을 빠뜨리면 안전한 쪽으로 동작하게 하기 위해서다.
