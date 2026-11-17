---
name: environment-validate
description: 명시적으로 선택한 Windows 개발 명령·작업 실행기와 Rust target·WSL·Docker·Process Compose의 실행과 종료를 검증할 때 사용합니다.
---

# 개발환경의 실행 검증

이 SKILL.md의 위치에서 두 단계 위가 설치한 플러그인의 루트입니다.
진입점은 `<플러그인 루트>/dist/cli.mjs`입니다.
Node.js 24 이상과 PowerShell 7이 필요합니다.

## 대상 선택

기본 doctor 보고서로 실행 문맥과 프로젝트의 요구를 확인합니다.
사용자가 요청한 배포판·context·서비스·프로젝트 명령을 구체적으로 선택합니다.
기존 요청이 해당 실행을 허용하면 불필요한 재확인을 추가하지 않습니다.
실행기 파일의 정적 탐지와 실제 작업 실행을 구분합니다.
목록 조회와 dry run도 설정을 평가할 수 있으므로 자동 실행하지 않습니다.
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
`--task-file`은 플러그인 JSON을 읽는 옵션입니다.
Go Task의 Taskfile YAML을 직접 전달하지 않습니다.
다음은 프로젝트에 선언된 mise의 `check` 작업을 선택하는 형식입니다.

```json
{
  "context": "native",
  "trusted": true,
  "tool": "mise",
  "args": ["run", "check"],
  "cwd": ".",
  "env": {}
}
```

```text
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --task-file "<선택한 작업 JSON>" --format json
```

기존 native 도구는 node·npm·python·uv·go·cargo·rustc·zig·dotnet·pwsh입니다.
0.3.0의 추가 실행기는 mise·task·just·make입니다.
Task·just·Make의 `check` 작업은 각각 `tool`을 task·just·make로 선택하고 `args: ["check"]`로 전달합니다.
실제 프로젝트가 사용하는 작업 이름과 인수를 보존합니다.
선택 항목 `cwd`는 대상 프로젝트 내부의 상대 경로나 절대 경로입니다.
생략하면 프로젝트 루트에서 실행합니다.
선택 항목 `env`는 자식 작업에만 전달할 환경 값의 객체입니다.
WSL 작업의 context는 wsl이며 tool에는 해당 배포판의 Linux 절대 경로를 사용합니다.
Rust 검증에 연결하는 작업의 context는 rust입니다.
도구 이름이나 인수를 셸 문자열로 보간하지 않습니다.
실행의 원시 출력과 비밀 환경변수는 보고서에 넣지 않습니다.
일반 환경 값도 보고서에 기록하지 않습니다.

플러그인 경유 mise 실행은 도구 자동 설치를 비활성화합니다.
`trusted: true`는 선택한 작업의 실행 요청입니다.
`mise trust`·자동 응답·신뢰 경로 확장을 자동 수행하지 않습니다.
mise 자체의 신뢰 처리는 설치한 버전과 paranoid 설정을 따릅니다.
실행기나 도구가 없거나 신뢰가 필요한 모드에서 거부되면 해당 실행 결과를 보고합니다.
Windows Job 실행의 종료 코드만으로 접근 거부 등의 원인을 확정하지 않습니다.
mise의 공유 상태 경로가 해당 샌드박스에서 쓰기 불가능한 경우도 구분합니다.
요청한 검증 범위에 맞춰 작업용 `env.MISE_STATE_DIR`를 명시할 수 있습니다.
전역 경로와 신뢰 설정을 자동 변경하지 않으며 기존 신뢰 기록을 복사하지 않습니다.
Task의 내장 셸·just의 기본 `sh`·mise의 Windows 기본 `cmd /c`를 대화형 PowerShell과 구분합니다.
PowerShell 작업은 `pwsh`를 명시한 기존 설정을 사용합니다.
설정 구문은 최신 공식 문서와 실제 설치 버전의 차이를 확인한 뒤 선택합니다.
just 1.52.0 예시는 `set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]`를 사용합니다.
실행기 도입이나 기존 작업의 자동 변환을 실행 검증의 선행 조건으로 만들지 않습니다.

## 결과

시작·준비 검사·종료 단계를 각각 설명합니다.
선택한 작업의 상태·종료 코드·정리 근거는 별도 `task` 결과로 설명합니다.
SH-01·ENV-02·PATH-01·REQ-01·RCM-01의 정적 근거와 작업 성공을 구분합니다.
기존 30개 check ID를 보존합니다.
unknown·skipped·cleanup 미확인을 통과로 바꾸지 않습니다.
시간 초과 후에는 소유 자원의 정리 근거와 남은 복구 범위를 확인합니다.
특정 호스트의 관찰을 모든 Windows·WSL·Docker 설치로 일반화하지 않습니다.

자세한 제한은 `../../docs/diagnostic-cli.md`에서 확인합니다.
실행기 예시와 2026-11-17에 확인한 공식 근거는 `../../docs/task-runners.md`에서 확인합니다.
