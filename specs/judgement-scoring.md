# 판정·스코어링

> 판정 시스템은 입력 타이밍을 평가해 판정과 점수로 환산한다.

## 배경

IIDX식 5단계 판정과 EX 스코어를 사용한다. 판정은 게이지([gauge-clear](gauge-clear.md))와
기록([results-records](results-records.md))의 입력이 된다.

## 요구사항

### 판정 윈도우 — MUST

1. 노트 시각과 입력 시각의 차(δ = 입력 − 노트, ms)로 판정한다. 기본값(튜닝 가능한 상수로 분리):

   | 판정 | 윈도우 |
   |---|---|
   | PGREAT | ±16.67ms |
   | GREAT | ±33.33ms |
   | GOOD | ±116.67ms |
   | BAD | ±250ms |

2. 레인별로 판정 윈도우 안에 있는 **가장 이른 미판정 노트** 하나만 판정 대상으로 삼는다. 판정된 노트는 소비된다.
3. **미스 POOR**: 노트가 BAD 윈도우의 늦은 쪽 끝을 지나도록 입력이 없으면 POOR로 확정한다.
4. **공(空) POOR**: 판정 윈도우 안에 노트가 없는 레인 입력은 공POOR로 기록한다. 공POOR는 게이지를 감소시키지만 콤보는 끊지 않는다.
5. 전역 판정 오프셋(사용자 보정값, ms)을 δ 계산에 반영한다([audio-playback](audio-playback.md)의 보정 설정).

### 콤보 — MUST

6. PGREAT/GREAT/GOOD은 콤보를 +1, BAD/미스POOR는 콤보를 0으로 리셋한다.
7. 최대 콤보를 추적한다. 모든 노트가 GOOD 이상이면 **FULL COMBO**다.

### 스코어 — MUST

8. **EX 스코어** = PGREAT×2 + GREAT×1. 이론상 최대치 = 총 노트 수 × 2.
9. **DJ 랭크**: 최대 EX 스코어 대비 비율로 산정 (IIDX 관례).

   | 랭크 | 조건 (max 대비) |
   |---|---|
   | AAA | ≥ 8/9 |
   | AA | ≥ 7/9 |
   | A | ≥ 6/9 |
   | B | ≥ 5/9 |
   | C | ≥ 4/9 |
   | D | ≥ 3/9 |
   | E | ≥ 2/9 |
   | F | < 2/9 |

10. 판정별 카운트(PGREAT/GREAT/GOOD/BAD/POOR, 공POOR 별도)를 집계한다. BP(BAD+POOR 합계)를 계산한다.

### 스크래치 — MUST

11. 스크래치 노트는 건반과 동일한 탭 판정으로 처리한다 (키보드 단일 키이므로 회전 개념 없음).

### SHOULD

12. CN(차지 노트): 시작은 탭과 동일 판정, 끝은 떼는 시점이 종료 윈도우(±116.67ms) 안이면 성공. 도중에 떼면 BAD 처리.
13. 판정 분포(δ 히스토그램)를 세션 중 수집해 결과 화면·연습 모드에서 활용.

### FAST/SLOW 분류 — MUST

14. 입력의 δ(전역 오프셋 반영, MUST 1·5와 동일한 값)로 확정된 판정 중 PGREAT를 제외한
    것(GREAT/GOOD/BAD, CN 시작 판정 포함)을 δ의 부호로 분류한다: δ < 0(노트보다 이른
    입력)은 **FAST**, δ > 0(늦은 입력)은 **SLOW**. δ 기반이 아닌 판정 — 미스 POOR(입력
    없음), 공POOR(대상 노트 없음), CN 도중 이탈 BAD — 는 분류하지 않는다. PGREAT는
    δ와 무관하게 어느 쪽도 아니다.
15. 판정 이벤트에 δ(ms)와 FAST/SLOW 분류를 포함해 발행한다. 표시 여부·형식은 표시
    옵션([play-options](play-options.md) MUST 18)과 렌더러([playfield-rendering](playfield-rendering.md)
    MUST 18)가 결정하며, 분류 자체는 판정·콤보·게이지·스코어에 영향을 주지 않는다.
16. 세션 동안 FAST/SLOW 개수를 각각 집계한다. 집계는 표시 옵션과 무관하게 항상 수행되고
    결과 화면([results-records](results-records.md) MUST 13)에 전달된다.

## 수용 기준

- [ ] δ = ±16ms 입력은 PGREAT, ±34ms는 GOOD 경계 케이스가 스펙 표와 일치한다 (단위 테스트).
- [ ] 겹친 두 노트(같은 레인 연타)에서 한 입력이 두 노트를 동시에 소비하지 않는다.
- [ ] 입력 없이 곡을 흘려보내면 모든 노트가 미스POOR로 집계되고 EX 스코어는 0이다.
- [ ] 오토플레이 결과는 항상 EX 스코어 최대치 + FULL COMBO다.
- [ ] 판정 로직은 렌더링 없이 헤드리스로 단위 테스트 가능하다.
- [ ] δ = −20ms 입력은 GREAT+FAST, δ = +20ms는 GREAT+SLOW로 분류된다 (단위 테스트).
- [ ] 오토플레이 결과의 FAST/SLOW 카운트는 항상 0이다 (모든 판정이 PGREAT).
- [ ] 미스POOR·공POOR는 FAST/SLOW 집계에 포함되지 않는다.

## 의존 관계

- 입력: [input-handling](input-handling.md) (레인+시각), [chart-format](chart-format.md) (노트 시각)
- 출력: [gauge-clear](gauge-clear.md) (판정 이벤트), [playfield-rendering](playfield-rendering.md) (판정 표시), [results-records](results-records.md) (집계)
