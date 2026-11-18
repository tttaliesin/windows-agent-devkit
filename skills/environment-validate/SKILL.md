---
name: environment-validate
description: 명시적으로 선택한 Windows 개발 명령·작업 실행기와 Rust target·WSL·Docker·Process Compose의 실행과 종료를 검증하거나 사용자가 반복 실행할 WSL 작업을 등록·조회·철회할 때 사용합니다.
---

# 개발환경의 실행 검증

이 SKILL.md가 있는 디렉터리에서 두 단계 위가 설치 루트입니다.
진입점은 `<플러그인 루트>/dist/cli.mjs`입니다.
`--project`에는 이미 존재하는 대상 프로젝트의 절대 경로를 지정합니다.
Node.js 24 이상과 PowerShell 7이 필요합니다.

## 대상 선택

실행 대상을 선택하지 않았거나 메타데이터만 확인하려면 `doctor`를 사용합니다.
기본 보고서로 실행 문맥과 프로젝트의 요구를 확인합니다.
사용자가 요청한 Rust target·배포판·Docker context·서비스·프로젝트 작업을 구체적으로 선택합니다.
기존 요청이 해당 실행을 허용하면 불필요한 재확인을 추가하지 않습니다.
실행기 파일의 정적 탐지와 실제 작업 실행을 구분합니다.
목록 조회와 dry run도 설정을 평가할 수 있으므로 자동 실행하지 않습니다.
기동이나 프로젝트 코드 실행에는 `validate --execute`를 사용합니다.
Rust 링크 검증을 실행하려면 `--rust-targets` 또는 작업 JSON의 `context: "rust"`를 명시합니다.
WSL 검증에는 배포판 이름과 배포판 내부에 이미 존재하는 Linux 절대 작업 경로를 지정합니다.
설정이나 이미지의 출처가 불분명하면 내용을 정적으로 확인해 범위를 먼저 구체화합니다.

```text
node "<플러그인 루트>/dist/cli.mjs" doctor --project "<프로젝트 경로>" --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --rust-targets x86_64-pc-windows-msvc --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --distro "<선택 배포판>" --linux-cwd "/home/<사용자>/<프로젝트>" --linux-tools bash --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --docker-context "<선택 context>" --image "<이미 존재하는 이미지>" --format json
node "<플러그인 루트>/dist/cli.mjs" validate --project "<프로젝트 경로>" --execute --service-config process-compose.yaml --services api,worker --format json
```

예시의 Rust target과 `--linux-tools`는 실제로 확인할 대상에 맞춰 바꿉니다.
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
지원하는 작업 실행기는 mise·task·just·make입니다.
Task·just·Make의 `check` 작업은 각각 `tool`을 task·just·make로 선택하고 `args: ["check"]`로 전달합니다.
실제 프로젝트가 사용하는 작업 이름과 인수를 보존합니다.
`native` 작업의 선택 항목 `cwd`는 대상 프로젝트 내부의 상대 경로나 절대 경로입니다.
생략하면 프로젝트 루트에서 실행합니다.
`native` 작업의 선택 항목 `env`는 자식 작업에만 전달할 환경 값의 객체입니다.
WSL 작업은 `context: "wsl"`과 `trusted: true`로 지정합니다.
WSL 작업의 `tool`에는 선택한 배포판의 Linux 절대 실행 경로를 사용합니다.
WSL 작업 호출에는 배포판과 Linux 작업 경로를 지정하고 `--task-file`을 함께 전달합니다.
Rust의 선택 작업은 `context: "rust"`와 `trusted: true`로 지정합니다.
`context`는 `native`, `rust`, `wsl`을 허용하며 오타 등 다른 값은 종료 코드 2를 반환합니다.
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

## 승인한 WSL 작업 등록

사용자가 반복 실행할 실제 작업을 선택한 경우 0.3.2의 `wsl-register`로 검토합니다.
규칙을 둘 Windows 프로젝트와 작업을 수행할 배포판 내부 Linux 디렉터리를 각각 확인합니다.
Linux 작업 디렉터리와 작업 JSON의 절대 `tool` 경로는 배포판의 네이티브 Linux 파일 시스템을 사용합니다.
선택한 명령이 평가하는 Makefile·Taskfile과 그 의존 코드, 배포판의 실행기와 인터프리터를 사용자가 신뢰하는지 확인합니다.
전용 Windows 실행 파일을 빌드할 때는 이미 설치된 Windows용 Go를 사용합니다.

아래 첫 명령의 읽기 전용 출력에서 등록 범위와 `confirmation` 지문을 확인합니다.
인수 원문과 순서는 작업 JSON에서 확인합니다.
사용자가 검토한 범위의 등록을 승인하면 동일한 입력과 반환된 지문으로 두 번째 명령을 실행합니다.
앱이 권한 승인을 요구하면 요청에 선택한 작업과 프로젝트에 남는 실행 규칙을 명시합니다.
앱이 요구한 권한 승인은 사용자가 직접 합니다.
앱의 프로젝트 신뢰 및 승인 설정은 사용자가 관리합니다.

```text
node "<플러그인 루트>/dist/cli.mjs" wsl-register --project "<Windows 프로젝트 경로>" --task-name "<등록 ID>" --distro "<배포판>" --linux-cwd "<Linux 절대 작업 경로>" --task-file "<선택한 작업 JSON>" --format json
node "<플러그인 루트>/dist/cli.mjs" wsl-register --project "<Windows 프로젝트 경로>" --task-name "<등록 ID>" --distro "<배포판>" --linux-cwd "<Linux 절대 작업 경로>" --task-file "<선택한 작업 JSON>" --execute --confirm "<반환된 confirmation 지문>"
node "<플러그인 루트>/dist/cli.mjs" wsl-tasks --project "<Windows 프로젝트 경로>"
node "<플러그인 루트>/dist/cli.mjs" wsl-unregister --project "<Windows 프로젝트 경로>" --task-name "<등록 ID>" --execute
```

등록 규칙은 그 Windows 프로젝트의 `.codex/rules/`에 둡니다.
신뢰된 같은 Windows 프로젝트에서 새 Codex 대화를 시작해 규칙을 사용합니다.
규칙이 적용되지 않으면 Codex를 재시작하고 새 대화에서 확인합니다.
프로젝트 루트를 Windows 호출의 작업 디렉터리로 지정하고 목록에 나온 전용 `.exe`의 절대 경로를 인수 없이 직접 실행합니다.
봉인된 실행 파일은 이전 대화의 캐시된 규칙으로 호출해도 작업 시작을 거부합니다.
실제 앱의 검증 상태와 Linux 작업 예시는 `../../docs/wsl-task-registration.md`에서 확인합니다.

## 결과

시작·준비 검사·종료 단계를 각각 설명합니다.
`native` 작업의 상태·종료 코드·정리 근거는 `report.task`에서 확인합니다.
Rust 작업의 증거는 `report.validation["RUST-02"].steps`의 `task` 단계에서 확인합니다.
WSL 작업의 증거는 `report.validation["WSL-02"].steps`의 `task` 단계에서 확인합니다.
`validate --execute`에서 명시적으로 선택한 검증 항목이 `unknown` 또는 `skipped`이면 종료 코드는 1입니다.
WSL 선행 검증이 끝나지 않아 선택 작업이 실행되지 않은 경우에도 종료 코드는 1입니다.
`doctor`나 실행 전 검토에서 선택하지 않은 대상의 `skipped`는 정상입니다.
SH-01·ENV-02·PATH-01·REQ-01·RCM-01의 정적 근거와 작업 성공을 구분합니다.
기존 30개 check ID를 보존합니다.
unknown·skipped·cleanup 미확인을 통과로 바꾸지 않습니다.
시간 초과 후에는 소유 자원의 정리 근거와 남은 복구 범위를 확인합니다.
특정 호스트의 관찰을 모든 Windows·WSL·Docker 설치로 일반화하지 않습니다.

자세한 제한은 `../../docs/diagnostic-cli.md`에서 확인합니다.
실행기 예시와 2026-11-17에 확인한 공식 근거는 `../../docs/task-runners.md`에서 확인합니다.
배포 버전과 실제 앱 검증 결과는 `../../docs/verification.md`에서 확인합니다.
