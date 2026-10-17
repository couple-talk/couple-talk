# app/

## 창 여러 개가 함께 쓰는 저장소

- 메인 창과 펫 창(`pet`, `pet-me`)은 출처가 같아서 localStorage와 IndexedDB(`ct-packs`)를 함께 쓴다.
- IndexedDB 연결은 요청마다 닫는다(`pack.ts`의 `store()`). 한 창이 연결을 열어 두면 다른 창의 `deleteDatabase`가 `blocked`되고, 그 뒤에 오는 `open`도 함께 멈춘다.
- 페이지를 떠나기 직전(`location.reload()` 등)에 보내는 `petEmit`은 `await`한다. IPC가 끝나기 전에 페이지가 바뀌면 이벤트가 사라진다.

## 펫 창

- 펫 창에서 `win.show()`는 상태가 실제로 바뀔 때만 부른다. macOS에서는 `show()`가 키 창이 되어 메인 창의 포커스를 가져가고, 창 설정의 `focus: false`는 생성할 때만 적용된다.
