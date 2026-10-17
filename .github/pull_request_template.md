<!--
PR 제목이 main의 커밋 메시지가 됩니다. 커밋 규칙을 따라 주세요.
예: feat(app): show read receipts
-->

## 개요

<!-- 무엇을, 왜 바꾸는지 한두 줄로 적습니다. -->

Closes #

## 변경사항

<!-- 리뷰어가 봐야 할 변경을 목록으로 적습니다. 화면이 바뀌었다면 스크린샷을 붙입니다. -->

-

## 테스트

<!-- 실행한 것에 체크합니다. 해당 없는 항목은 지웁니다. -->

- [ ] `cd server && npm test`
- [ ] `cd app && npm run check && npx tsc --noEmit`
- [ ] `cd app/src-tauri && cargo test --lib -- --ignored` (키체인 코드를 바꾼 경우)
- [ ] `npm run tauri dev`로 직접 확인: <!-- 무엇을 해 봤는지 -->

<!-- 암호화, 키 저장, 서버 인증을 바꿨다면 README 보안 모델도 맞게 고쳤는지 확인합니다. -->
