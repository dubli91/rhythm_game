# 개요 — 비트매니아 IIDX 스타일 웹 리듬게임

## JTBD (Job to be Done)

> **"브라우저만으로, 설치 없이 비트매니아 IIDX 스타일의 리듬게임을 키보드로 플레이하고 실력을 쌓는다."**

## 핵심 결정 사항 (인터뷰 결과, 2026-07-14 / 2026-07-16 개정: BMS 임포트 제외 — 내장 곡 + 연습 모드만 제공 / 2026-07-21 개정: 무음원·단일 키음 연습곡 1곡을 **최우선**으로 추가)

| 항목 | 결정 |
|---|---|
| 키 모드 | 7키 + 스크래치 (IIDX SP 표준) |
| 채보 형식 | 자체 내부 JSON 포맷 (내장 곡·연습 패턴 전용) |
| 오디오 | 단일 음원 + 효과음 (키음 실시간 재생 없음 — 예외: [practice-song-content](practice-song-content.md) 연습곡의 단일 키음 1종) |
| 입력 장치 | 키보드 전용 (키 컨피그 지원) |
| 판정 | IIDX식 5단계 (PGREAT/GREAT/GOOD/BAD/POOR) + EX 스코어 |
| 게이지 | 풀세트 (ASSIST EASY / EASY / NORMAL / HARD / EX-HARD) |
| 플레이 옵션 | 하이스피드, SUDDEN+(레인커버), RANDOM/MIRROR, 오토플레이 |
| 연습 기능 | 노트 패턴을 몇 마디 작성해 반복 연습하는 연습 세션 |
| 기록 저장 | 로컬 저장만 (서버 없음) |
| 렌더링 | WebGL (PixiJS) |
| 스택 | TypeScript + Vite (프레임워크 없는 바닐라 구성) |
| 곡 제공 | 내장 곡만 |

## 토픽 구성 (1 토픽 = 1 스펙)

| 스펙 | 한 문장 정의 |
|---|---|
| [chart-format](chart-format.md) | 내부 채보 포맷은 플레이에 필요한 노트·타이밍 데이터를 정의한다 |
| [song-library](song-library.md) | 곡 라이브러리는 내장 곡을 보관·관리한다 |
| [song-select](song-select.md) | 곡 선택 화면은 라이브러리를 탐색해 플레이할 곡과 옵션을 고르게 한다 |
| [input-handling](input-handling.md) | 입력 시스템은 키보드 입력을 정확한 타임스탬프와 함께 게임 액션으로 전달한다 |
| [judgement-scoring](judgement-scoring.md) | 판정 시스템은 입력 타이밍을 평가해 판정과 점수로 환산한다 |
| [gauge-clear](gauge-clear.md) | 게이지 시스템은 판정 결과에 따라 게이지를 증감시켜 클리어 여부를 결정한다 |
| [play-options](play-options.md) | 플레이 옵션은 채보의 표시·배치 방식을 플레이어가 조정하게 한다 |
| [playfield-rendering](playfield-rendering.md) | 플레이필드 렌더러는 진행 중인 채보를 WebGL로 60fps 스크롤 표시한다 |
| [audio-playback](audio-playback.md) | 오디오 시스템은 단일 음원을 재생하며 게임 전체의 마스터 클럭을 제공한다 |
| [practice-mode](practice-mode.md) | 연습 세션은 몇 마디 분량의 노트 패턴을 작성해 반복 연습하게 한다 |
| [results-records](results-records.md) | 기록 시스템은 플레이 결과를 확정해 보여주고 로컬 베스트 기록으로 관리한다 |
| [app-shell-navigation](app-shell-navigation.md) | 앱 셸은 화면 상태 기계를 관리하며 부팅 시퀀스, 화면 전환, DOM/PixiJS 경계를 규정한다 |
| [settings-screen](settings-screen.md) | 설정 화면은 키 컨피그·판정 오프셋·볼륨 등 전역 설정을 한 곳에서 조회하고 변경하게 한다 |
| [builtin-song-content](builtin-song-content.md) | 내장 곡 콘텐츠는 앱과 함께 배포되는 오리지널 곡·채보 자산의 구성·라이선스·제작 파이프라인을 정의한다 |
| [practice-song-content](practice-song-content.md) | **[우선순위 최상위]** 연습곡 콘텐츠는 BPM 282 코드+스크래치 패턴을 무음원·단일 키음으로 실전 경로에서 연습하는 내장 연습곡을 정의한다 |

## 기술 베이스라인

- **언어/빌드**: TypeScript, Vite. UI 프레임워크 없음(메뉴는 DOM, 플레이는 PixiJS 캔버스).
- **렌더링**: PixiJS (WebGL), 목표 60fps.
- **오디오**: Web Audio API. `AudioContext.currentTime`이 게임의 유일한 마스터 클럭.
- **저장소**: 연습 패턴은 IndexedDB, 기록·설정은 localStorage.

## 명시적 비목표 (v1에서 하지 않는 것)

- 사용자 곡 추가(BMS 임포트) — 곡은 내장 곡만 제공 (2026-07-16 결정)
- 멀티플레이, 서버 기록, 온라인 리더보드
- 키음 실시간 재생 (BGM 단일 트랙으로 통일) — 유일한 예외: [practice-song-content](practice-song-content.md) 연습곡의 단일 키음 1종
- BGA(배경 영상) 재생
- 게임패드/전용 컨트롤러, 터치스크린 입력
- 더블 플레이(DP), 5키 모드
- 플레이 중 일시정지 (ESC는 곡 포기)
