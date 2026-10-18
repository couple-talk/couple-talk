# 기여 규칙

두 사람이 같은 저장소에서 작업하기 위한 규칙입니다. `main`은 항상 빌드되고 테스트가 통과하는 상태로 둡니다.

## 흐름

1. 작업할 이슈를 고르고 본인에게 할당합니다.
2. 최신 `main`에서 브랜치를 만듭니다.
3. 작게 커밋하면서 작업합니다.
4. PR을 열고 템플릿을 채웁니다. 본문에 `Closes #이슈번호`를 적으면 머지할 때 이슈가 닫힙니다.
5. CI가 통과하고 상대방이 승인하면 머지합니다.

`main`에는 직접 push하지 않습니다. PR로만 머지되며, 상대방 리뷰 1명과 CI 통과가 필수입니다.

## 브랜치 이름

`종류/짧은-설명` 형태로, 소문자와 하이픈만 씁니다.

| 접두어 | 용도 | 예 |
|---|---|---|
| `feat/` | 새 기능 | `feat/read-receipts` |
| `fix/` | 버그 수정 | `fix/pet-speech-bubble` |
| `docs/` | 문서만 바꿀 때 | `docs/self-hosting` |
| `chore/` | 빌드, CI, 설정 등 | `chore/ci-and-contributing` |

## 커밋 메시지

[Conventional Commits](https://www.conventionalcommits.org/ko/v1.0.0/)를 따릅니다. 기존 기록과 같이 영어 명령형으로 씁니다.

```
<type>(<scope>): <무엇을 하는지>
```

- **type**: `feat`, `fix`, `docs`, `test`, `chore`, `ci`, `refactor`
- **scope**: 바뀌는 곳. `app`, `server`처럼 쓰고, 여러 곳에 걸치거나 루트 파일이면 생략합니다.
- 제목은 72자 이내로, 마침표 없이 씁니다. 이유가 필요하면 한 줄 띄우고 본문에 적습니다.

```
feat(server): store encrypted character packs per room
fix(app): report a missing keychain key instead of a wrong password
docs: describe two characters and pack import/transfer
```

## 커밋과 PR 크기

- **PR 하나에 기능 하나.** PR이 `main`에 커밋 하나로 들어가므로, PR이 곧 되돌리기와 기록의 단위입니다. 관련 없는 수정이 보이면 따로 이슈나 PR로 뺍니다.
- **커밋은 작게.** 브랜치 안에서는 리팩터링과 기능 추가처럼 성격이 다른 변경을 커밋으로 나눠 두면 리뷰가 쉬워집니다.
- 리뷰하기 어려울 만큼 커지면(대략 변경 400줄 이상) 쪼갤 수 있는지 먼저 확인합니다.

## 머지

- **Squash and merge**만 씁니다. PR 하나가 `main`에 커밋 하나로 들어갑니다.
- 그래서 **PR 제목이 곧 `main`의 커밋 메시지**입니다. PR 제목도 위 커밋 메시지 규칙을 따릅니다(예: `feat(app): show read receipts`). GitHub가 끝에 `(#PR번호)`를 붙입니다.
- 브랜치 안의 커밋은 리뷰하기 편하게 나누면 되고, `wip`나 `fix typo`가 섞여도 머지할 때 합쳐집니다.
- 머지된 브랜치는 자동으로 지워집니다.

## 테스트

PR을 올리기 전에 로컬에서 돌려 봅니다. 같은 검사를 CI가 PR마다 실행합니다.

```sh
cd server && npm test
cd app && npm run check && npx tsc --noEmit
```

CI는 macOS와 Windows에서 앱 빌드(`tauri build --debug --no-bundle`)도 확인합니다. 실제 OS 키체인을 쓰는 `cargo test --lib -- --ignored`는 CI에서 돌지 않으므로, 키체인 관련 코드를 바꿨다면 직접 실행하고 PR에 결과를 적습니다.

## 메시지 형식 변경

`app/src/protocol.ts`는 두 사람의 앱이 주고받는 메시지 형식입니다. 한쪽만 업데이트한 상태에서도 대화가 깨지면 안 되므로, 이 파일을 바꾸는 PR은 다음을 지킵니다.

- 리뷰 봇 승인만으로 머지하지 않고, **상대방이 직접 리뷰하고 승인**합니다.
- PR 설명에 무엇이 바뀌는지, 예전 앱이 새 메시지를 받으면(또는 새 앱이 예전 메시지를 받으면) 어떻게 되는지 적습니다.

## 보안 관련 변경

암호화, 키 저장, 서버 인증을 건드리는 PR은 README의 [보안 모델](README.md#보안-모델)이 여전히 맞는지 확인하고, 달라졌다면 같은 PR에서 README도 고칩니다.
