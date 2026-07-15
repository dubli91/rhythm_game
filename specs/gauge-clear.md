# 게이지·클리어

> 게이지 시스템은 판정 결과에 따라 게이지를 증감시켜 클리어 여부를 결정한다.

## 배경

IIDX 풀세트 게이지(ASSIST EASY / EASY / NORMAL / HARD / EX-HARD)를 제공한다.
게이지 종류는 클리어 램프의 종류를 결정한다([results-records](results-records.md)).

## 요구사항

### 공통 — MUST

1. 게이지는 0~100%의 실수. 곡 시작 시 종류별 초기값으로 설정하고, 판정 이벤트마다 증감한다.
2. 회복량의 기준 단위 `R = total / 총노트수` (%). `total`은 채보의 게이지 총량 값([chart-format](chart-format.md)).
3. 모든 수치는 밸런스 조정을 위해 상수 테이블로 분리한다. 아래 표는 초기 기본값이다 (LR2/IIDX 관례 근사).

### 회복형 게이지 (ASSIST EASY / EASY / NORMAL) — MUST

4. 초기값 22%, 하한 2% (0%가 되어도 폐곡 없음). **곡 종료 시 80% 이상이면 클리어** (ASSIST EASY만 60% 이상).

   | 판정 | NORMAL | EASY / ASSIST EASY |
   |---|---|---|
   | PGREAT | +R | +R×1.2 |
   | GREAT | +R | +R×1.2 |
   | GOOD | +R/2 | +R×0.6 |
   | BAD | −2.0% | −1.6% |
   | 미스POOR | −6.0% | −4.8% |
   | 공POOR | −2.0% | −1.6% |

5. ASSIST EASY 게이지의 증감은 EASY와 동일하고 클리어 라인만 60%다.

### 생존형 게이지 (HARD / EX-HARD) — MUST

6. 초기값 100%. **0%에 도달하면 즉시 폐곡(FAILED)**, 곡 종료까지 생존하면 클리어.

   | 판정 | HARD | EX-HARD |
   |---|---|---|
   | PGREAT | +0.16% | +0.16% |
   | GREAT | +0.16% | +0.16% |
   | GOOD | +0.08% | +0.08% |
   | BAD | −6% | −12% |
   | 미스POOR | −10% | −20% |
   | 공POOR | −2% | −4% |

7. HARD는 게이지 30% 미만일 때 감소량을 절반으로 완화한다. EX-HARD는 완화 없음.

### 폐곡 처리 — MUST

8. 생존형 게이지가 0%가 되면 즉시 플레이를 중단하고(음원 페이드아웃) FAILED 결과 화면으로 이동한다.
9. 회복형 게이지로 곡을 끝까지 쳤지만 클리어 라인 미달이면 FAILED다 (결과 화면까지는 진행).

### 표시 — MUST

10. 게이지 잔량과 클리어 라인(80%/60%)을 플레이필드에 표시한다. 생존형은 붉은 계열, 회복형은 청/녹 계열로 구분한다([playfield-rendering](playfield-rendering.md)).

### SHOULD

11. HARD 폐곡 시 "어디서 죽었는지"(곡 진행률 %)를 결과 화면에 표시.

## 수용 기준

- [ ] 판정 시퀀스를 주입하는 단위 테스트로 5종 게이지의 증감·클리어 판정이 표와 일치한다.
- [ ] HARD에서 게이지 29%일 때 BAD 감소량이 −3%로 완화된다.
- [ ] EX-HARD에서 미스POOR 5연속으로 즉시 폐곡된다.
- [ ] NORMAL 79.9%는 FAILED, 80.0%는 CLEAR로 판정된다.

## 의존 관계

- 입력: [judgement-scoring](judgement-scoring.md)의 판정 이벤트
- 출력: [results-records](results-records.md) (클리어 램프), [playfield-rendering](playfield-rendering.md) (게이지 표시)
- 선택 UI: [song-select](song-select.md)의 옵션 패널에서 게이지 종류 선택
