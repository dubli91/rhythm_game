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

10. 기록 전체 JSON 내보내기/가져오기 (브라우저·기기 이전용). 기존 기록이 있는 브라우저로 가져오면 차트별(MUST 4의 `songId`+`chartId` 키)로 필드 단위 최선값 병합을 하여 로컬 진행도를 절대 낮추지 않는다: `clearLamp`는 상위 램프, `bestExScore`는 높은 값(각각 이긴 쪽의 rank·배치 유지), `minBP`는 낮은 값, `playCount`는 두 값의 최대치(합산이 아님 — 같은 파일을 두 번 가져와도 중복 집계되지 않게), `lastPlayedAt`는 더 나중 값을 택한다. 이 병합은 멱등이므로 같은 파일을 재차 가져와도 결과가 동일하고, 로컬 라이브러리에 없는 곡의 기록도 그대로 가져온다(기록은 이 키로 라이브러리와 독립).
11. 플레이어 통계(총 플레이 수, 램프 분포, 레벨별 클리어 현황)는 별도 화면 상태가 아니라 설정 화면 내 기록 섹션의 인-설정 모달로 제공한다([settings-screen](settings-screen.md) SHOULD 13 참조) — 오프셋 보정 진입처럼 설정 화면 안에서 처리하며 app-shell-navigation의 화면 열거형은 그대로 둔다.
12. songId를 결정적으로 생성(제목+아티스트 해시 등)해, 내장 곡 자산을 재빌드하거나 카탈로그를 재구성해도 기존 기록이 같은 곡에 다시 연결되게 한다.

### FAST/SLOW 카운트 — MUST

13. 결과 화면에 FAST/SLOW 카운트([judgement-scoring](judgement-scoring.md) MUST 16)를
    판정별 카운트(MUST 1)와 함께 표시한다. 표시 모드([play-options](play-options.md)
    MUST 18)가 OFF인 플레이에서도 동일하게 집계·표시된다. 저장 기록(MUST 4)에는
    반영하지 않는다 — 결과 화면 표시 전용이며 기록 문서 스키마는 불변이다.

## 수용 기준

- [ ] HARD CLEAR 후 NORMAL로 FAILED해도 램프는 HARD CLEAR로 유지된다.
- [ ] EX 스코어가 낮은 재플레이에서 bestExScore가 내려가지 않는다.
- [ ] FULL COMBO 시 램프가 FULL COMBO로 갱신된다 (사용 게이지와 무관하게 최상위).
- [ ] 새로고침·브라우저 재시작 후에도 기록이 유지된다.
- [ ] 내보낸 JSON을 초기화된 브라우저에서 가져오면 기록이 완전 복원된다.
- [ ] 같은 파일을 두 번 가져와도 기록은 한 번 가져온 것과 동일하며, 가져오기가 기존 램프·`bestExScore`를 낮추지 않는다.
- [ ] 결과 화면에 FAST/SLOW 카운트가 표시되고, 표시 모드 OFF로 플레이해도 동일하게 집계·표시된다.
- [ ] FAST/SLOW 도입 전후로 기록 저장 문서(MUST 4)의 스키마가 동일하다.

## 의존 관계

- 입력: [judgement-scoring](judgement-scoring.md) 집계, [gauge-clear](gauge-clear.md) 클리어 결과, [play-options](play-options.md) 사용 옵션
- 소비자: [song-select](song-select.md)의 램프·베스트 표시, [settings-screen](settings-screen.md) 기록 섹션의 통계·내보내기/가져오기 진입(SHOULD 10-11)
