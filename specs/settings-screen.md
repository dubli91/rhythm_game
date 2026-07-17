# 설정 화면

> 설정 화면은 키 컨피그·판정 오프셋·볼륨 등 전역 설정을 한 곳에서 조회하고 변경하게 한다.

## 배경

곡 선택 화면([song-select](song-select.md) MUST 10)에서 진입하는 전역 설정 허브다. DOM 기반 UI로 구현한다.
키 재할당의 판정·저장 로직은 [input-handling](input-handling.md)이, 판정 오프셋·볼륨의 수치·범위와
보정 로직은 [audio-playback](audio-playback.md)이 소유한다. 이 스펙은 화면 구성·내비게이션·저장 UX만
정의하며, 값의 의미·범위·적용 방식은 재정의하지 않고 소유 스펙을 참조한다.

## 요구사항

### 화면 구성 — MUST

1. 하나의 화면에 필수 네 섹션을 둔다: 키 컨피그, 판정 오프셋, 볼륨, 오프셋 보정 진입 (SHOULD 13의 기록 섹션이 SHOULD 티어로 추가될 수 있다). 각 헤더에 현재 값을 요약 표시한다 (예: 오프셋 "+12ms", 볼륨 "마스터 80%").
2. 판정 오프셋 섹션: −200 ~ +200ms 범위의 스텝퍼/슬라이더 하나([audio-playback](audio-playback.md) MUST 7). ms 단위 정수로 표시한다.
3. 볼륨 섹션: 마스터/음악/효과 3개 슬라이더(0~100%)([audio-playback](audio-playback.md) MUST 9). 효과 슬라이더 조정 시 확인용 효과음을 재생한다.
4. 오프셋 보정 진입: 버튼 하나로 보정 화면(SHOULD 12)에 진입한다. 보정 알고리즘 자체는 이 스펙에서 정의하지 않는다.

### 키 컨피그 — MUST

5. 레인 목록을 스크래치 → 건반 1~7 순서로 나열하고, 각 레인의 현재 바인딩을 `event.code` 원문으로 표시한다 (예: `KeyS`, `ShiftLeft`).
6. 레인을 선택하면 캡처 모드로 들어가 다음 키 입력을 그 레인에 할당한다([input-handling](input-handling.md) MUST 7). 캡처 중임을 화면에 명시한다 (예: "키 입력 대기중").
7. 이미 다른 레인에 쓰인 키를 입력하면 할당을 거부하고 충돌 레인을 강조 표시한다([input-handling](input-handling.md) MUST 8).
8. 레인별 및 전체 "기본값으로 초기화" 버튼을 제공한다.

### 내비게이션 — MUST

9. 방향키로 섹션·항목 이동, Enter로 선택/토글/캡처 시작, Escape로 곡 선택 화면 복귀([input-handling](input-handling.md) SHOULD 11). 캡처 모드 중에는 Escape가 화면 이탈이 아니라 캡처 취소로 동작한다.
10. 예약 키(`Escape`, `PageUp`, `PageDown`, `Home`, `ArrowUp`, `ArrowDown`)는 레인에 바인딩할 수 없다 — 플레이 중 옵션 조작에 쓰인다([play-options](play-options.md) MUST 3, 6). 캡처 중 이 키(Escape 제외)를 누르면 사유를 표시하며 거부하고, Escape는 사유 없이 캡처만 취소한다.

### 저장·적용 — MUST

11. 모든 변경(키 매핑·오프셋·볼륨)은 즉시 localStorage에 저장하고 새로고침 없이 적용된다: 오프셋은 다음 판정 계산부터, 볼륨은 다음 GainNode 업데이트부터 반영한다([audio-playback](audio-playback.md) MUST 5, 9). 저장된 설정이 없거나 손상된 경우 각 섹션은 기본값으로 폴백하며 화면은 정상 렌더링된다 (크래시 없음).

### SHOULD

12. 오프셋 보정 화면: 일정 BPM 클릭에 맞춰 약 16회 입력을 받아 평균 오차를 계산하고, 제안 오프셋을 적용/취소 선택지로 제시한다 (계산·적용 로직은 [audio-playback](audio-playback.md) SHOULD 10을 따른다).
13. 기록 섹션: 통계와 내보내기/가져오기를 모으는 다섯 번째 섹션을 둔다(SHOULD 티어). 플레이어 통계(총 플레이 수·램프 분포·레벨별 클리어 현황, [results-records](results-records.md) SHOULD 11)는 오프셋 보정 진입처럼 별도 화면 상태(app-shell-navigation 화면 열거형)를 만들지 않으며, 설정 화면 내 모달로 연다. 기록 JSON 내보내기/가져오기 진입점([results-records](results-records.md) SHOULD 10)도 이 섹션에 둔다. 통계·내보내기/가져오기 로직 자체는 이 스펙에서 정의하지 않는다.
14. localStorage 키 이름을 표준화한다: 설정은 `settings.v1` 형식의 단일 버전 문서 하나로 저장한다 (키 매핑·오프셋·볼륨 포함).

## 수용 기준

- [ ] 키보드만으로 곡 선택 → 설정 진입 → 각 섹션 이동 → 값 변경 → Escape로 곡 선택 복귀까지 가능하다.
- [ ] 이미 사용 중인 키를 새 레인에 할당하려 하면 거부되고 충돌 레인이 표시된다.
- [ ] 오프셋을 변경한 직후(화면 이탈 없이) 플레이를 시작하면 변경된 오프셋이 적용된다.
- [ ] localStorage를 비우거나 손상시킨 뒤 설정 화면을 열어도 앱이 죽지 않고 기본값이 표시된다.
- [ ] 캡처 모드에서 Escape는 캡처만 취소한다; 캡처 모드가 아닐 때 Escape는 곡 선택으로 돌아간다.
- [ ] 예약 키(PageUp/PageDown/Home/ArrowUp/ArrowDown/Escape)는 레인에 할당되지 않는다.
- [ ] 새로고침 후에도 키 매핑·오프셋·볼륨이 유지된다.

## 의존 관계

- 진입: [song-select](song-select.md) (MUST 10, 설정 목적지)
- 위임: [input-handling](input-handling.md) (키 재할당 로직·저장, MUST 7-9), [audio-playback](audio-playback.md) (오프셋·볼륨 값·보정 로직, MUST 7, 9 / SHOULD 10-11)
- 진입점 제공: [results-records](results-records.md) (SHOULD 10 내보내기/가져오기, SHOULD 11 통계 — 기록 섹션)
- 참조: [play-options](play-options.md) (플레이 중 조작 키와의 충돌 회피, MUST 3, 6)

## 미해결 질문

- 오프셋 보정 화면을 설정 화면 내 모달로 둘지 별도 화면 전환으로 둘지 미정.
