# server/

## HTTP 핸들러

- `node:http` 핸들러 안에서 동기로 던진 예외는 잡히지 않고 프로세스를 죽인다. WebSocket까지 함께 끊기므로, 핸들러 안의 DB 호출은 try로 감싸고 503으로 답한다 (`/healthz`, `/metrics`).
