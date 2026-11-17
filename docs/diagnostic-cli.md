# 진단 CLI 사용법

이 문서는 첫 진단 CLI의 실행 방법과 확인할 수 있는 범위를 설명합니다.
기준 버전은 0.1.0입니다.

## 실행 전제조건

진단 CLI에는 Node.js 24 이상과 PowerShell 7이 필요합니다.
Windows 11 x64를 첫 실행 대상으로 사용합니다.
권장 PowerShell 계열은 7.6 LTS입니다.
진단용 Node.js와 대상 프로젝트가 요구하는 Node.js는 별도 역할입니다.
프로젝트의 실행 버전은 해당 프로젝트에서 선택된 경로를 조회해 비교합니다.
추가 Node.js 패키지 설치와 빌드는 필요하지 않습니다.

## 실행

저장소 루트에서 다음 명령을 실행합니다.

```powershell
node src/cli.mjs --project .
node src/cli.mjs --project 'C:\src\example' --format json
```

JSON은 표준 출력으로 반환합니다.
기본 텍스트 출력은 한국어로 제공합니다.
지원하는 옵션은 다음 명령으로 확인합니다.

```powershell
node src/cli.mjs --help
```

프로젝트 선언에 없는 계열을 명시적으로 확인하려면 언어 목록을 전달합니다.
지원하는 이름은 `node`, `python`, `go`, `rust`, `zig`, `dotnet`입니다.

```powershell
node src/cli.mjs --project 'C:\src\example' --languages 'node,python' --format json
```

WSL과 컨테이너의 호스트 조회는 다음 옵션으로 요청합니다.
컨테이너나 Process Compose 선언이 있는 프로젝트에서는 해당 메타데이터 항목이 자동 적용됩니다.
컨테이너 선언만으로 언어 도구를 Windows 호스트에 설치해야 한다고 판단하지 않습니다.
이 경우 호스트 언어 도구의 요구는 미확인으로 남깁니다.
Windows에서 해당 언어 도구를 직접 사용할 때는 `--native`나 `--languages`로 호스트 점검을 명시합니다.

```powershell
node src/cli.mjs --project . --wsl --containers --process-compose --format json
```

보고서 저장은 요청한 경로에만 수행합니다.
기존 파일은 덮어쓰지 않으므로 반복 실행에는 다른 파일명을 사용합니다.

```powershell
node src/cli.mjs --project . --format json --output .local/doctor.json
```

`--timeout-ms`는 각 조회의 제한 시간을 밀리초로 지정합니다.
기본값은 5000이며 허용 범위는 100부터 30000입니다.

## 첫 구현의 확인 범위

보고서는 P0 22개 ID를 반환합니다.
각 ID의 전체 설계가 모두 구현됐다는 의미는 아닙니다.
첫 구현은 다음의 제한된 관찰과 비교를 제공합니다.

| 대상 | 첫 구현의 관찰 | 별도 검증이 필요한 내용 |
| --- | --- | --- |
| Windows와 셸 | OS·아키텍처·작업 경로·설정을 읽지 않은 PowerShell 문맥 | 릴리스별 공식 지원, 사용자 프로필과 앱 통합 터미널 설정 |
| 실행 경로 | 고정된 도구 이름의 후보와 파일 메타데이터 | 사용자 세션의 함수·alias, 전체 설치 이력과 업데이트 책임 |
| 여섯 언어 | 인식하는 선언 파일과 허용한 실제 버전 조회 | 모든 선언 문법, 실제 빌드·테스트와 네이티브 링크 |
| 의존성 | 패키지 관리자 선언과 잠금 파일 | 복원·동기화와 가상환경의 전체 정상 동작 |
| mise | 명령 경로와 인식한 프로젝트 버전 선언 | 셸 활성화와 백엔드·proxy의 실제 선택 |
| Git | 명령 경로와 허용한 버전 조회, 정책 파일 존재 | 원격 인증, 전체 추적 파일의 줄바꿈 검사 |
| WSL | 요청한 호스트 메타데이터 | 배포판 내부 개발 도구와 실행 |
| Docker | CLI 경로와 허용한 클라이언트 버전 조회 | Compose·context의 전체 해석과 엔진 연결 |
| Lazydocker | 명령 경로와 파일 메타데이터 | TUI·Compose 설정과 엔진 연결 |
| Process Compose | 선언 파일 존재와 명령 경로·파일 메타데이터 | YAML의 전체 의미·환경변수 평가·서비스 기동 |
| 권장 비교 | 진단 PowerShell과 필요한 mise 명령 경로의 비교, 전환안 필드 | 구체적인 설치 이력, 사용자 선택의 영구 저장과 전환 적용 |

TOML과 다른 비 JSON 선언은 알려진 필드를 정적으로 읽는 제한된 분석을 사용합니다.
분석 범위는 지정한 프로젝트 루트의 알려진 선언 파일입니다.
상위 디렉터리의 `global.json`과 하위 모노레포·CI의 요구는 자동 분석하지 않습니다.
지원하지 않는 표현과 읽기 오류는 `unknown`과 근거로 남깁니다.
소스 코드·빌드 스크립트·프로필·환경변수 표현을 평가하지 않습니다.

버전 비교는 숫자 버전·최소 버전·일반 비교 연산자·wildcard·caret·tilde와 제한된 .NET SDK 대체 규칙을 지원합니다.
복잡한 표현·채널 이름·prerelease를 검증하지 못하면 통과로 처리하지 않습니다.
Go의 `go.sum`은 버전 잠금 파일이 아니라 무결성 자료로 취급합니다.
Go의 로컬 조회와 자동 toolchain 선택은 구분합니다.
Rust의 관리자 proxy와 검증하지 않은 wrapper는 실행을 보류합니다.
.NET SDK 목록과 `global.json`의 실제 SDK 선택은 구분합니다.

## 결과 해석

`schemaVersion`은 보고서 형식의 버전입니다.
`pluginVersion`과 `policyVersion`은 구현과 권장 기준의 버전입니다.
`context`는 조회한 실행 문맥입니다.
`checks`는 22개 항목의 결과입니다.
`deferredChecks`는 P1의 후속 ID 8개입니다.

| 상태 | 의미 |
| --- | --- |
| `pass` | 해당 항목에 명시한 확인 범위의 요구를 충족 |
| `fail` | 명령 해석 부족 또는 확인한 요구 위반 |
| `warn` | 전환안이나 선언 충돌 등의 검토 사항 |
| `unknown` | 조회하지 않았거나 근거·지원 범위가 부족 |
| `skipped` | 해당 요구가 없거나 기본 실행 범위에서 제외 |

`resolution`, `execution`, `compatibility`는 각각 기록합니다.
공식 지원 상태는 첫 구현에서 자동 조회하지 않아 `support.status`에 `unknown`을 기록합니다.
종료 코드 0은 모든 실행환경의 공식 지원이나 전체 빌드 성공을 보장하지 않습니다.

| 종료 코드 | 의미 |
| --- | --- |
| 0 | 보고서 생성 완료와 확인한 요구 위반 없음 |
| 1 | 보고서에서 하나 이상의 요구 위반 확인 |
| 2 | 옵션·전제조건·프로젝트 경로·수집기 등의 실행 오류 |

## 검증 명령

```powershell
node --test
node scripts/check-package.mjs
```

테스트는 임시 프로젝트의 선언·상태 판정·조회 실행 경계를 검사합니다.
플러그인 검사는 기본 매니페스트 형식·Skill·참조 파일과 문서를 확인합니다.
앱에서 플러그인을 설치하고 발견·호출하는 검증은 별도 단계입니다.

```mermaid
flowchart LR
    A["프로젝트 선언 정적 분석"] --> B["허용한 로컬 조회"]
    B --> C["요구·권장 차이·미확인 구분"]
    C --> D["JSON 또는 한국어 보고서"]
```
