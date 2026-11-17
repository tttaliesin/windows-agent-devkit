---
name: environment-setup
description: Windows 개발환경의 변경 계획과 요청한 적용·복구를 수행하거나 기존 도구·작업 실행기의 유지 사유를 기록할 때 사용합니다.
---

# Windows 개발환경 설정과 복구

이 SKILL.md의 위치에서 두 단계 위가 설치한 플러그인의 루트입니다.
Node.js 24 이상과 PowerShell 7을 실행 기준으로 사용합니다.
진입점은 `<플러그인 루트>/dist/cli.mjs`입니다.
대상 프로젝트의 디렉터리와 플러그인 루트를 구분합니다.

## 계획

현재 프로젝트의 선언과 설치 환경을 먼저 진단합니다.
기존 환경을 정상적으로 사용하더라도 적용되는 권장안과 차이를 제시합니다.
프로젝트의 런타임·패키지 관리자·잠금 파일·빌드 명령·CI를 보존합니다.
신규 다중언어 프로젝트의 공통 작업 진입점에는 mise tasks를 기본 권장합니다.
기존 Task·just·Make·npm scripts에는 권장 차이와 전환안 또는 유지 사유를 제시합니다.
전환안에는 기존 작업·내부 셸·작업 디렉터리·CI 호출의 보존과 복구 범위를 적습니다.
최신 문서의 설정 구문을 적용하기 전에 실제 실행기 버전과 대조합니다.
just 1.52.0의 Windows 예시는 `set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]`를 사용합니다.
설정 파일의 includes와 지원하지 않는 동적 문법은 실행해서 해석하지 않습니다.
작업 실행기 설치·설정 자동 변환·필수 hook·마이그레이션을 권장만으로 수행하지 않습니다.
.NET은 공식 SDK 설치와 global.json을 사용합니다.
Nu는 선택 도구입니다.

```text
node "<플러그인 루트>/dist/cli.mjs" plan --project "<프로젝트 경로>" --roles runtime-version-manager --versions node=24.18.1 --format json --output "<새 계획 JSON 경로>"
```

버전 예시는 명령 형식을 보여줍니다.
실제 버전은 프로젝트의 요구와 확인한 공식 릴리스에서 선택합니다.
latest나 stable 같은 이동하는 이름을 설치 버전으로 넘기지 않습니다.
역할·정확한 버전·프로필 경로는 필요한 범위만 명시합니다.
`--roles powershell-profile --profile <절대 경로>`는 지정한 파일에 mise 활성화 블록을 계획합니다.
설치 역할은 `mise`, `powershell`, `windows-terminal`, `git`, `vscode`, `docker`, 여섯 언어, `uv`, `lazydocker`, `process-compose`입니다.
`--versions`가 없는 역할은 설치하지 않습니다.
계획의 differences·operations·보존 범위·복구 제한을 사용자에게 설명합니다.
기존 승인으로 요청 범위가 분명하면 불필요한 재확인을 추가하지 않습니다.

## 적용과 복구

```text
node "<플러그인 루트>/dist/cli.mjs" apply --project "<프로젝트 경로>" --plan "<검토한 계획 JSON 경로>" --execute --format json
node "<플러그인 루트>/dist/cli.mjs" rollback --project "<프로젝트 경로>" --journal "<반환된 저널 ID>" --execute --format json
```

개인 계획·백업·저널은 저장소 밖의 상태 디렉터리에 둡니다.
직접 지정할 때는 모든 관련 명령에 같은 `--state-dir` 절대 경로를 사용합니다.
계획 후 선언이나 예외가 달라졌으면 새 계획을 만듭니다.
재실행 결과가 already_applied이면 같은 작업을 반복하지 않습니다.
공유 도구 설치는 자동 제거 대상으로 간주하지 않습니다.
동시 편집 충돌은 사용자 내용을 보존하고 복구 근거를 설명합니다.
설치나 변경의 실패를 성공으로 요약하지 않습니다.

## 유지 예외

```text
node "<플러그인 루트>/dist/cli.mjs" exception --project "<프로젝트 경로>" --role runtime-version-manager --reason "<기존 도구 유지 사유>" --scope project --execute --format json
```

예외에는 인증 값이나 파일 원문을 넣지 않습니다.
기존 실행기를 유지하는 이유와 프로젝트 범위도 설명에 남깁니다.
CLI의 유지 예외 기록은 실행 중인 버전이 지원하는 역할만 사용합니다.
새 예외 역할이나 자동 전환 기능이 있다고 가정하지 않습니다.
예외를 저장해도 프로젝트 요구와 권장안의 차이를 보고서에서 숨기지 않습니다.
적용 후 진단과 요청한 개발 명령을 다시 확인합니다.
목록 조회와 dry run도 설정 평가를 유발할 수 있으므로 진단의 일부로 자동 실행하지 않습니다.
선택한 mise 작업의 도구 자동 설치는 플러그인 경유 실행에서 비활성화합니다.
작업 실행을 이유로 mise 설정 신뢰를 자동 승격하지 않습니다.

자세한 명령은 `../../docs/diagnostic-cli.md`에서 확인합니다.
실행기별 선택 기준·Windows 셸·전환 예시는 `../../docs/task-runners.md`에서 확인합니다.
