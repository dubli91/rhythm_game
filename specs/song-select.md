# 곡 선택

> 곡 선택 화면은 라이브러리를 탐색해 플레이할 곡과 옵션을 고르게 한다.

## 배경

내장 곡과 임포트 곡이 병합된 카탈로그([song-library](song-library.md))를 탐색하고,
난이도·옵션을 정해 플레이로 진입하는 허브 화면이다. DOM 기반 UI로 구현한다.

## 요구사항

### 목록 — MUST

1. 곡 목록을 표시한다: 제목, 아티스트, 장르, BPM(변속 곡은 min~max), 출처(내장/임포트).
2. 곡을 펼치면 난이도별 채보 목록: 난이도 슬롯(NORMAL/HYPER/ANOTHER 등), 레벨(1~12), 노트 수.
3. 채보별 베스트 기록을 함께 표시한다: 클리어 램프(색), DJ 랭크, EX 스코어([results-records](results-records.md)).
4. 정렬: 제목순 / 레벨순 / 클리어 램프순. 마지막 정렬 기준 저장.
5. 키보드 탐색: 방향키로 곡·난이도 이동, Enter 결정, Escape 뒤로. 마우스 클릭도 지원.

### 옵션 패널 — MUST

6. 플레이 시작 전 현재 옵션을 표시하고 변경할 수 있다: 게이지 종류(ASSIST EASY~EX-HARD), 배치(OFF/RANDOM/MIRROR), 하이스피드, SUDDEN+ ([play-options](play-options.md), [gauge-clear](gauge-clear.md)).
7. 오토플레이 시작 항목을 옵션 패널에 둔다.
8. 옵션은 곡과 무관한 전역 설정으로 저장되어 다음 곡에도 유지된다.

### 진입/로딩 — MUST

9. 곡 결정 시 채보·음원을 로드하고(내장: fetch, 임포트: IndexedDB) 로딩 표시 후 플레이 화면으로 전환한다. 로드 실패 시 곡 선택으로 복귀하며 원인을 표시한다.
10. 곡 선택 화면에서 연습 세션([practice-mode](practice-mode.md))과 설정(키 컨피그·오프셋·볼륨), 임포트 화면으로 이동할 수 있다.

### SHOULD

11. 검색(제목/아티스트 부분 일치).
12. 미리듣기: 곡에 커서를 올리면 하이라이트 구간 재생([audio-playback](audio-playback.md)).
13. 레벨 폴더 뷰 (레벨 1~12별 그룹핑).

## 수용 기준

- [ ] 곡 100개(임포트 포함)에서 목록 스크롤·탐색이 지연 없이 동작한다.
- [ ] 키보드만으로 곡 선택 → 난이도 선택 → 옵션 변경 → 플레이 시작까지 가능하다.
- [ ] 클리어 램프 색이 기록과 일치하며, 플레이 후 돌아오면 갱신되어 있다.
- [ ] 음원이 삭제된(스토리지 정리 등) 임포트 곡을 선택하면 앱이 죽지 않고 오류 안내가 나온다.

## 의존 관계

- 읽기: [song-library](song-library.md) 카탈로그, [results-records](results-records.md) 기록
- 쓰기: [play-options](play-options.md)·[gauge-clear](gauge-clear.md) 선택값 (전역 설정)
- 전환: 플레이 화면, [practice-mode](practice-mode.md), 설정, 임포트
