# 입력 처리

> 입력 시스템은 키보드 입력을 정확한 타임스탬프와 함께 게임 액션으로 전달한다.

## 배경

입력 장치는 키보드 전용이다. 판정 정확도는 입력 타임스탬프의 정확도에 직결되므로,
프레임 루프에서 폴링하지 않고 **이벤트 시점의 타임스탬프**를 판정에 사용한다.

## 요구사항

### 입력 캡처 — MUST

1. `keydown`/`keyup` 이벤트를 사용하고 `event.repeat`는 무시한다. 키 식별은 물리 위치 기반인 `event.code`를 사용한다 (한/영 상태·레이아웃 무관).
2. 각 입력은 `event.timeStamp`(performance.now 기준)를 보존하고, 판정 시 오디오 클럭 기준 곡 시간으로 변환한다([audio-playback](audio-playback.md)의 변환 함수 사용). 판정은 "이벤트가 발생한 시각" 기준이어야 하며 "프레임이 처리한 시각" 기준이어서는 안 된다.
3. 8개 레인(스크래치 + 건반 7개)의 동시 입력을 각각 독립적으로 처리한다.
4. 게임 플레이 중에는 매핑된 키의 브라우저 기본 동작을 `preventDefault()`로 차단한다 (Space 스크롤 등).
5. 기본 매핑:
   | 레인 | 기본 키 (event.code) |
   |---|---|
   | 스크래치 | `ShiftLeft` |
   | 1~7 | `KeyS` `KeyD` `KeyF` `Space` `KeyJ` `KeyK` `KeyL` |
6. 게임플레이 외 조작: 곡 포기(`Escape`), 플레이 중 옵션 조작 키([play-options](play-options.md)에서 정의)를 전달한다.

### 키 컨피그 — MUST

7. 설정 화면에서 레인별 키 재할당: 레인을 선택하면 다음 키 입력이 그 레인에 할당된다.
8. 중복 할당은 거부하고 어느 레인과 충돌하는지 보여준다.
9. 매핑은 localStorage에 저장하고 앱 시작 시 복원한다. "기본값으로 초기화" 제공.

### SHOULD

10. keydown 시각과 판정 처리 지연을 개발자 오버레이에서 확인할 수 있는 디버그 표시. 지연 = 판정 처리 시점의 `performance.now()` − `event.timeStamp`이며, 마지막 표본과 세션 평균을 함께 표시한다. 진단 전용이다 — 판정 자체는 항상 이벤트 타임스탬프(MUST 2)를 쓰므로 이 지연은 판정에 영향을 주지 않는다. `F1`로 토글한다([playfield-rendering](playfield-rendering.md) SHOULD 16과 오버레이 공유). 오토플레이에서는 표본을 기록하지 않는다.
11. 메뉴(곡 선택·설정·결과)도 전부 키보드로 조작 가능하게 한다 (방향키/Enter/Escape).

## 수용 기준

- [ ] 7키 + 스크래치를 물리적으로 동시에 눌렀을 때 8개 입력이 모두 각자의 레인으로 전달된다.
- [ ] 한글 입력 상태(IME)에서도 판정 입력이 정상 동작한다.
- [ ] 60fps가 무너진 상황에서도 판정 결과가 이벤트 시각 기준으로 계산된다 (프레임 지연이 판정 오차로 이어지지 않음).
- [ ] 키 재할당 후 새로고침해도 매핑이 유지된다.

## 의존 관계

- 소비자: [judgement-scoring](judgement-scoring.md) (레인+시각), [playfield-rendering](playfield-rendering.md) (키 빔 표시), [play-options](play-options.md) (플레이 중 조작)
- 의존: [audio-playback](audio-playback.md) (performance.now → 곡 시간 변환)
