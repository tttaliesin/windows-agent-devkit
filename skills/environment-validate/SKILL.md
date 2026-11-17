---
name: environment-validate
description: 명시적으로 선택한 Windows 개발 명령, Rust target, WSL 배포판, Docker context·기존 이미지·Compose 서비스, Process Compose 서비스의 실행과 종료를 검증할 때 사용합니다.
---

# 개발환경의 실행 검증

이 SKILL.md의 위치에서 두 단계 위가 설치한 플러그인의 루트입니다.
진입점은 `<플러그인 루트>/dist/cli.mjs`입니다.
Node.js 24 이상과 PowerShell 7이 필요합니다.

## 대상 선택

기본 doctor 보고서로 실행 문맥과 프로젝트의 요구를 확인합니다.
사용자가 요청한 배포판·context·서비스·프로젝트 명령을 구체적으로 선택합니다.
기존 요청이 해당 실행을 허용하면 불필요한 재확인을 추가하지 않습니다.
기동이나 프로젝트 코드 실행에는 validate와 --execute를 함께 사용합니다.
설정이나 이미지의 출처가 불분명하면 내용을 정적으로 확인해 범위를 먼저 구체화합니다.

```text
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --distro "<선택 배포판>" --linux-cwd "/home/<사용자>/<프로젝트>" --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --docker-context "<선택 context>" --image "<이미 존재하는 이미지>" --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --service-config process-compose.yaml --services api,worker --format json
```

Docker 이미지는 자동 pull하지 않습니다.
Compose 검증은 `--compose-file`과 선택한 `--services`를 함께 전달합니다.
새로 만든 검증 자원만 소유 라벨과 고유 이름으로 정리합니다.
기존 컨테이너·볼륨·서비스·프로세스를 삭제하지 않습니다.
Process Compose의 준비 검사 선언이 없으면 실행 중이라는 사실만으로 준비 완료를 주장하지 않습니다.

## 기존 프로젝트 명령

프로젝트에서 이미 사용하는 명령과 인수를 읽어 task JSON을 만듭니다.
다음은 Windows 네이티브 Node.js 테스트 명령의 형식입니다.

```json
{
  "context": "native",
  "trusted": true,
  "tool": "node",
  "args": ["--test"]
}
```

```text
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --task-file "<선택한 작업 JSON>" --format json
```

native 도구는 node·npm·python·uv·go·cargo·rustc·zig·dotnet·pwsh입니다.
WSL 작업의 context는 wsl이며 tool에는 해당 배포판의 Linux 절대 경로를 사용합니다.
Rust 검증에 연결하는 작업의 context는 rust입니다.
도구 이름이나 인수를 셸 문자열로 보간하지 않습니다.
실행의 원시 출력과 비밀 환경변수는 보고서에 넣지 않습니다.

## 결과

시작·준비 검사·종료 단계를 각각 설명합니다.
unknown·skipped·cleanup 미확인을 통과로 바꾸지 않습니다.
시간 초과 후에는 소유 자원의 정리 근거와 남은 복구 범위를 확인합니다.
특정 호스트의 관찰을 모든 Windows·WSL·Docker 설치로 일반화하지 않습니다.

자세한 제한은 `../../docs/diagnostic-cli.md`에서 확인합니다.
