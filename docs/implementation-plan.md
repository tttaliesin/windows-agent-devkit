# 첫 진단 CLI의 구현 범위

이 문서는 첫 구현의 실행 계약과 검증 범위를 기록합니다.
작성일은 2026-11-17입니다.

## 실행 환경

기존 PC에서 확인한 Node.js 24를 첫 CLI의 최소 런타임 계열로 선택합니다.
Windows 호스트 조회는 PowerShell 7을 설정 파일 없이 실행합니다.
Node.js 기본 모듈과 PowerShell 기본 기능을 사용합니다.
추가 패키지 설치 없이 테스트할 수 있는 구성을 사용합니다.
진단 CLI를 실행할 Node.js가 없으면 먼저 실행 전제조건을 준비해야 합니다.
대상 프로젝트의 Node.js 요구는 진단 CLI의 실행 런타임 요구와 별도로 비교합니다.

## 첫 구현의 산출물

프로젝트 선언을 정적으로 읽는 분석기를 구현합니다.
Windows 호스트와 명령 경로를 조회하는 수집기를 구현합니다.
P0 22개 항목을 JSON과 한국어 텍스트로 보고하는 CLI를 구현합니다.
지원하지 않는 선언과 확인하지 않은 동작은 미확인으로 남깁니다.
P1의 실제 서비스 기동과 컨테이너 실행은 이 구현에 포함하지 않습니다.
로컬 플러그인 매니페스트와 진단 Skill을 소스로 제공합니다.
앱 설치·계정 등록·공개 배포는 별도 작업입니다.

## 프로젝트 분석기 계약

`src/project.mjs`의 `analyzeProject(projectPath)`는 비동기로 결과를 반환합니다.
`requirements`의 키는 `node`, `python`, `go`, `rust`, `zig`, `dotnet`입니다.
각 항목은 `state`, `versionRequests`, `packageManagers`, `lockFiles`, `metadata`, `notes`를 포함합니다.
`state`는 `required`, `not_required`, `unknown` 중 하나입니다.
버전 요청은 `source`, `field`, `kind`, `value`를 포함합니다.
`kind`는 `exact`, `minimum`, `range`, `channel`, `preferred`, `sdk` 중 하나입니다.
선언 파일을 읽지 못한 경우에는 관련 요구를 `unknown`으로 유지합니다.
원시 파일 내용과 비밀 값은 반환하지 않습니다.
`environment`는 `containers`와 `processCompose`의 적용 상태를 포함합니다.
`files`는 확인한 선언 파일의 상대 경로 목록입니다.
`issues`는 `source`와 한국어 `message`를 포함합니다.

## Windows 수집기 계약

`src/windows.mjs`의 `inspectWindows({ projectPath, timeoutMs, tools })`는 비동기로 결과를 반환합니다.
`context`는 OS와 프로세스 아키텍처, 작업 경로, 진단 셸 정보를 포함합니다.
진단 셸은 `diagnosticShell`에 이름·경로·버전과 `profileApplied: false`를 기록합니다.
`commands`는 도구 이름을 키로 하는 후보 배열입니다.
명령 후보는 `name`, `commandType`, `path`, `fileVersion`, `productVersion`을 포함합니다.
`probes`는 도구 이름을 키로 하는 조회 결과입니다.
조회 결과는 `state`, `executable`, `arguments`, `exitCode`, `version`, `data`, `reason`을 포함합니다.
`state`는 `succeeded`, `failed`, `not_found`, `not_run`, `timed_out` 중 하나입니다.
명령 실행은 고정한 조회 명령과 인수 배열로 제한합니다.
자동 설치 가능성이 있는 proxy·shim의 실행은 보류합니다.
버전만 확인한 도구를 프로젝트의 전체 개발환경 검증 완료로 표현하지 않습니다.

## 검증

선언 파일 오류와 지원하지 않는 버전 표현을 수용 사례로 검사합니다.
정상 실행과 프로젝트 요구 위반을 각각 검사합니다.
관리자 proxy와 서비스 기동 명령이 기본 조회에서 실행되지 않는지 검사합니다.
실제 Windows 프로젝트에서 CLI의 JSON 보고서를 확인합니다.
진단 전후 대상 프로젝트 파일의 변경 여부를 비교합니다.
실행 검증이 끝난 기능만 사용 문서와 작업 계획에서 완료로 표시합니다.
