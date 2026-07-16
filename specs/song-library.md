# 곡 라이브러리

> 곡 라이브러리는 내장 곡을 보관·관리한다.

## 배경

곡은 앱과 함께 배포되는 **내장 곡**만 제공한다(사용자 곡 추가는 v1 비목표,
[00-overview](00-overview.md)). 곡 선택 화면([song-select](song-select.md))은 이 카탈로그를
단일 곡 목록으로 표시한다.

## 요구사항

### 내장 곡 — MUST

1. 내장 곡은 정적 자산으로 배포한다: `songs/index.json`(곡 목록·메타데이터) + 곡별 채보 JSON + 음원 파일(ogg).
2. 곡 목록 메타데이터는 앱 시작 시 로드하고, 채보·음원은 곡 결정 시(플레이 직전) 지연 로드한다.
3. 최소 3곡 이상의 내장 곡을 포함한다 (난이도 스펙트럼 확인용: 저레벨/중레벨/고레벨).

## 수용 기준

- [ ] 내장 곡은 네트워크 지연이 있어도 곡 선택 목록 표시를 막지 않는다 (메타데이터만 선로드).
- [ ] 채보·음원 로드 실패 시 앱이 죽지 않고 곡 선택으로 복귀하며 원인이 표시된다([song-select](song-select.md) 요구사항 9).

## 의존 관계

- 입력: [builtin-song-content](builtin-song-content.md) 정적 자산
- 소비자: [song-select](song-select.md) (카탈로그), [audio-playback](audio-playback.md) (음원 로드)
