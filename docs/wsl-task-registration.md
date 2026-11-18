# 승인한 WSL 작업 등록

Windows Agent Devkit 0.3.2의 등록 절차는 사용자가 반복 실행할 기존 WSL 작업을 선택할 때 사용합니다.
실제 Codex 앱에서 작업을 실행한 결과는 [검증 기록](verification.md#032-wsl-작업-등록)에서 확인합니다.

## Windows 프로젝트와 Linux 작업 준비

`--project`에는 Codex에서 열 Windows 프로젝트의 절대 경로를 지정합니다.
`--distro`와 `--linux-cwd`에는 작업을 수행할 배포판과 그 안에 이미 있는 Linux 프로젝트의 절대 경로를 지정합니다.
작업 디렉터리와 실행 파일은 배포판의 네이티브 Linux 파일 시스템에 있어야 합니다.
실제 경로가 `/mnt/c` 같은 Windows 드라이브 마운트에 있으면 네이티브 Linux 경로를 선택합니다.
등록에는 대상 Windows 프로젝트 밖에 있는 플러그인 설치본을 사용합니다.
전용 실행 파일을 빌드할 때는 Windows `PATH`에서 확인할 수 있는 기존 Go가 필요합니다.

아래 예시는 WSL의 `/home/me/src/example`에 있는 Python 프로젝트에서 `tests.test_api`의 테스트를 실행합니다.
Make를 사용하는 프로젝트는 네이티브 Linux 작업 디렉터리 안의 `Makefile`에 있는 작업을 선택합니다.

```makefile
.PHONY: check
check:
	/usr/bin/python3 -m unittest tests.test_api
```

Go Task를 사용하는 프로젝트는 같은 Linux 디렉터리의 `Taskfile.yml`에 있는 작업을 선택할 수 있습니다.

```yaml
version: '3'
tasks:
  check:
    cmds:
      - /usr/bin/python3 -m unittest tests.test_api
```

실제 프로젝트에서 사용 중인 작업 이름과 도구 경로로 바꿉니다.
작업이 평가하는 설정·포함 파일·의존 작업·스크립트와 배포판의 실행기·인터프리터는 사용자가 신뢰해야 합니다.
Windows 작업 공간의 편집과 실행 대상을 분리하려면 작업이 읽는 코드와 설정도 Linux 쪽 프로젝트에 둡니다.
작업 자체는 배포판의 사용자 권한으로 실행되므로 그 코드가 읽거나 수정하는 대상은 작업의 동작을 검토해 판단합니다.

## 검토하고 등록

아래 네 필드를 Windows에서 읽을 수 있는 `wsl-check.json`에 저장합니다.
`args`의 순서는 작업을 실행할 때 그대로 사용됩니다.
작업 인수에는 비밀 값을 넣지 않습니다.

```json
{
  "context": "wsl",
  "trusted": true,
  "tool": "/usr/bin/make",
  "args": ["check"]
}
```

Go Task를 선택했다면 `tool`을 배포판에 설치된 `task`의 실제 Linux 절대 경로로 바꿉니다.
`--task-file`에는 선택한 명령을 담은 JSON을 지정합니다.

[CLI 준비 절차](diagnostic-cli.md#실행-전제조건)의 `$cli`와 `$projectRoot`를 사용합니다.
아래 배포판과 경로는 준비한 실제 대상으로 바꿉니다.
`--task-name`에는 영문자 또는 숫자로 시작하는 1~64자의 ID를 지정합니다.
나머지 자리에는 영문자·숫자·하이픈·밑줄을 사용할 수 있습니다.

```powershell
$taskFile = Join-Path $projectRoot 'wsl-check.json'
$registerArgs = @(
  '--project', $projectRoot,
  '--task-name', 'check-api',
  '--distro', 'Ubuntu-24.04',
  '--linux-cwd', '/home/me/src/example',
  '--task-file', $taskFile
)
node $cli wsl-register @registerArgs --format json
```

첫 명령은 승인 입력을 확인하는 읽기 전용 검토입니다.
검토 결과에서 Windows 프로젝트 경로, 등록 ID, 배포판, Linux 작업 경로, 도구와 인수 개수를 확인합니다.
인수 원문과 순서는 작업 JSON에서 확인합니다.
해당 범위를 등록하기로 결정했으면 결과의 `confirmation` 값을 아래에 넣습니다.
확인한 입력이나 플러그인 버전이 달라지면 다시 검토해 지문을 받습니다.

```powershell
$confirmation = '<검토 결과의 confirmation 값>'
node $cli wsl-register @registerArgs --execute --confirm $confirmation
```

Codex 앱이 이 등록 명령의 권한 승인을 요청하면 사용자가 검토한 호출을 직접 승인합니다.
등록 규칙은 선택한 Windows 프로젝트의 `.codex/rules/`에만 기록됩니다.
Git 작업 트리에서는 등록 결과의 `gitExcluded`로 생성한 규칙의 로컬 제외 여부를 확인합니다.
프로젝트 신뢰 여부와 앱의 샌드박스·승인 설정은 사용자가 Codex에서 관리합니다.

## 조회하고 실행

```powershell
node $cli wsl-tasks --project $projectRoot
```

목록에서 상태가 `active`인 작업의 `executable`을 확인합니다.
신뢰된 같은 Windows 프로젝트에서 새 Codex 대화를 시작합니다.
규칙이 적용되지 않으면 Codex를 재시작하고 새 대화에서 다시 확인합니다.

Codex 로컬 규칙의 `allow`는 일치하는 명령을 샌드박스 밖에서 실행할 수 있게 합니다.
OpenAI 문서는 프로젝트의 `.codex` 계층이 신뢰된 경우 해당 로컬 규칙을 시작 시 읽는다고 설명합니다.
공식 규칙 문서 확인일은 2026-11-18입니다. [OpenAI Codex Rules](https://developers.openai.com/codex/rules)

호출의 Windows 작업 디렉터리를 `--project`와 같은 경로로 지정합니다.
목록에 나온 전용 `.exe`의 절대 경로를 인수 없이 직접 호출합니다.
전용 실행 파일이 승인된 배포판과 Linux 작업 디렉터리에서 승인한 도구와 인수를 사용합니다.
성공 결과에는 `checkId: "WSL-02"`와 `task.execution: "succeeded"`가 표시됩니다.
전용 실행 파일의 종료 코드도 함께 확인합니다.
전용 실행 파일이 호출하는 검증의 개별 조회와 작업에는 15초 제한이 적용됩니다.
일반 `wsl.exe` 호출은 Codex의 기존 승인 정책을 따릅니다.
실제 실행 결과, 적용 범위와 Windows 작업 공간 편집의 영향은 [설치본 검증 기준](completion-contract.md#설치본-검증-기준)에 따라 확인합니다.

```mermaid
flowchart LR
    subgraph Windows["Windows 호스트"]
        Chat["신뢰된 프로젝트의 새 Codex 대화"]
        Launcher["프로젝트 밖의 전용 .exe"]
        Chat -->|"프로젝트 로컬 규칙과 Windows 작업 경로"| Launcher
    end
    subgraph WSL["선택한 WSL 배포판"]
        Task["Linux 작업 경로의 Make 또는 Task"]
    end
    Launcher -->|"승인한 도구와 인수"| Task
```

## 철회

```powershell
node $cli wsl-unregister --project $projectRoot --task-name 'check-api' --execute
node $cli wsl-tasks --project $projectRoot
```

성공한 철회는 `state: "revoked"`로 표시합니다.
봉인된 실행 파일은 이전 대화의 캐시된 규칙으로 호출해도 작업 시작을 거부합니다.
작업 변경을 다시 승인하려면 새 입력으로 검토부터 진행합니다.
