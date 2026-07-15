# 결과·기록

> 기록 시스템은 플레이 결과를 확정해 보여주고 로컬 베스트 기록으로 관리한다.

## 배경

서버 없이 로컬 저장만 사용한다. 기록은 곡 선택 화면의 램프·스코어 표시와
결과 화면의 "NEW RECORD" 판단에 쓰인다.

## 요구사항

### 결과 화면 — MUST

1. 곡 종료(클리어/FAILED/폐곡) 후 결과를 표시한다:
   - CLEAR / FAILED 및 사용 게이지 종류
   - DJ 랭크(AAA~F), EX 스코어 (이론치 대비 %)
   - 판정별 카운트(PGREAT/GREAT/GOOD/BAD/POOR), 공POOR, BP, 최대 콤보
   - 사용 옵션(배치, 하이스피드, SUDDEN+)
2. 자기 베스트와 비교해 EX 스코어 차이(±)를 표시하고, 갱신 항목에 NEW RECORD 표기.
3. 결과 화면에서 재도전(같은 곡·같은 옵션) 또는 곡 선택 복귀가 가능하다.

### 기록 저장 — MUST

4. 키: `songId + chartId`. 저장 필드:
   - `clearLamp`: NO PLAY < FAILED < ASSIST CLEAR < EASY CLEAR < CLEAR < HARD CLEAR < EX-HARD CLEAR < FULL COMBO — **상위 램프만 갱신** (하위 결과로 내려가지 않음)
   - `bestExScore`, `bestRank`: EX 스코어 갱신 시에만 교체
   - `minBP`: 최소 BP 별도 추적
   - `playCount`, `lastPlayedAt`
5. 램프와 베스트 스코어는 독립 갱신이다 (예: EASY로 스코어 갱신 + 기존 HARD CLEAR 램프 유지).
6. 저장 위치는 localStorage, 버전 필드를 가진 단일 JSON 문서. 쓰기는 곡 종료 시 1회.
7. **오토플레이와 연습 세션 결과는 기록에 반영하지 않는다.**
8. RANDOM/MIRROR 사용 플레이도 기록으로 인정하되 기록에 옵션 사용 여부를 남긴다.

### 데이터 안전 — MUST

9. 파싱 불가능한 기록 데이터(손상)를 만나면 앱이 죽지 않고, 백업 후 초기화할지 사용자에게 묻는다.

### SHOULD

10. 기록 전체 JSON 내보내기/가져오기 (브라우저·기기 이전용).
11. 플레이어 통계 화면: 총 플레이 수, 램프 분포, 레벨별 클리어 현황.
12. 곡 삭제([song-library](song-library.md)) 시 기록은 유지 — 재임포트하면 다시 연결되도록 songId를 결정적으로 생성(제목+아티스트 해시 등)하는 것과 연동.

## 수용 기준

- [ ] HARD CLEAR 후 NORMAL로 FAILED해도 램프는 HARD CLEAR로 유지된다.
- [ ] EX 스코어가 낮은 재플레이에서 bestExScore가 내려가지 않는다.
- [ ] FULL COMBO 시 램프가 FULL COMBO로 갱신된다 (사용 게이지와 무관하게 최상위).
- [ ] 새로고침·브라우저 재시작 후에도 기록이 유지된다.
- [ ] 내보낸 JSON을 초기화된 브라우저에서 가져오면 기록이 완전 복원된다.

## 의존 관계

- 입력: [judgement-scoring](judgement-scoring.md) 집계, [gauge-clear](gauge-clear.md) 클리어 결과, [play-options](play-options.md) 사용 옵션
- 소비자: [song-select](song-select.md)의 램프·베스트 표시
