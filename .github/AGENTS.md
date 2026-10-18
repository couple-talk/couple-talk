# .github/

## 배포 워크플로

- 맥미니 self-hosted runner를 쓰는 워크플로에는 `pull_request` 트리거를 넣지 않는다. 공개 저장소라 포크 PR의 코드가 맥미니에서 돈다.
- `workflow_dispatch` 입력을 배포 대상으로 쓰면 `checkout` 전에 형식을 확인하고(전체 40자 SHA), 교체 전에 `main` 커밋인지와 그 커밋이 지금 배포 방식을 지원하는지 확인한다. 입력은 `${{ }}`를 `run`에 직접 넣지 말고 `env`로 넘긴다.
- 롤백이 남겨 둔 이미지를 쓰려면 `docker compose up`에 `--build`를 붙이지 않는다. `build:`와 `image:`가 함께 있으면 태그가 없을 때만 빌드한다.
