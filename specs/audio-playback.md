# 오디오 재생·마스터 클럭

> 오디오 시스템은 단일 음원을 재생하며 게임 전체의 마스터 클럭을 제공한다.

## 배경

키음 방식이 아닌 단일 음원 방식이므로, 곡당 오디오는 트랙 1개다.
리듬게임의 싱크는 오디오 클럭이 기준이어야 하므로 `AudioContext.currentTime`을 유일한 시간원으로 삼는다.

예외: 연습곡([practice-song-content](practice-song-content.md))은 음원 없이 단일 키음만
재생한다 (MUST 2 소스 노드의 예외). 이때도 t0 예약(MUST 3)과 곡 시간 변환(MUST 5)은
동일하게 적용된다. 연습곡의 곡별오프셋(MUST 5)은 0이며(키음 엔트리의 `offsetMs`가 0),
곡 시간 공식은 그 외 완전히 동일하다.

## 요구사항

### 재생 — MUST

1. `AudioContext`는 사용자 제스처(첫 키 입력/클릭) 후 unlock한다. suspended 상태 처리 포함.
2. 곡 재생은 `AudioBufferSourceNode` 하나로 한다: 음원을 fetch+decode해 사용한다.
3. 재생 시작 시각 `t0 = ctx.currentTime + 리드인` 으로 예약 시작(`source.start(t0)`)한다. 리드인(기본 1초) 동안 카운트다운 없이 채보가 미리 스크롤되어 내려온다.
4. 플레이 중 일시정지는 없다. `Escape`는 곡 포기이며 음원을 페이드아웃 후 정지한다. 폐곡([gauge-clear](gauge-clear.md))도 동일한 정지 경로를 쓴다.

### 마스터 클럭 — MUST

5. 곡 시간 변환 함수를 제공한다:
   `songTimeMs = (ctx.currentTime − t0) × 1000 − 전역오프셋 + 곡별오프셋`.
   판정·렌더링·연습 모드가 모두 이 함수만 사용한다.
6. 입력 이벤트의 `performance.now` 시각을 곡 시간으로 변환하는 함수를 제공한다. `ctx.currentTime`과 `performance.now`의 대응은 `ctx.getOutputTimestamp()`(미지원 시 보정 샘플링)로 유지한다. 입력 판정([judgement-scoring](judgement-scoring.md))은 이 변환을 통해 이벤트 시각 기준으로 이뤄진다.
7. 전역 오프셋(판정 보정값): 설정에서 −200 ~ +200ms 조정 가능, localStorage 저장.

### 효과음 — MUST

8. 메뉴 조작음(이동/결정/취소)과 연습 모드 메트로놈 클릭을 짧은 버퍼로 재생한다.
9. 볼륨 3계열(마스터/음악/효과)을 GainNode로 분리하고 설정에 저장한다.

### SHOULD

10. 오프셋 보정 화면: 일정 BPM 클릭에 맞춰 키를 두드리면 평균 오차를 측정해 전역 오프셋을 제안.
11. `AudioContext.outputLatency`(지원 브라우저)를 초기 오프셋 추정에 활용.
12. 곡 미리듣기 재생 (곡 선택 화면에서 하이라이트 구간 반복, [song-select](song-select.md)).

## 수용 기준

- [ ] 같은 곡을 10회 반복 플레이해도 판정 중앙값(δ 평균)의 편차가 ±2ms 이내다 (클럭 드리프트 없음).
- [ ] 곡 포기·폐곡·정상 종료 후 AudioContext에 잔여 재생 노드가 남지 않는다.
- [ ] 전역 오프셋을 +50ms로 바꾸면 판정 δ 분포가 그만큼 이동한다.
- [ ] 첫 상호작용 전 자동재생 정책으로 인한 에러가 발생하지 않는다.

## 의존 관계

- 소비자: [judgement-scoring](judgement-scoring.md), [playfield-rendering](playfield-rendering.md), [practice-mode](practice-mode.md)
- 음원 출처: [song-library](song-library.md)
