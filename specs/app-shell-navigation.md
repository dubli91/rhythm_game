# 앱 셸·화면 전환

> 앱 셸은 화면 상태 기계를 관리하며 부팅 시퀀스, 화면 전환, DOM/PixiJS 경계를 규정한다.

## 배경

각 화면 스펙(곡 선택, 결과, 연습 등)은 자신이 이미 활성 상태라고 가정하고 그 안의 요구사항만
정의한다. 화면이 언제 나타나고 사라지는지, 앱이 어떤 순서로 부팅되는지, 오디오 언락은 언제
이뤄지는지를 규정하는 스펙이 없었다. 본 스펙이 그 공백을 메운다.

## 요구사항

### 화면 상태 기계 — MUST

1. 화면은 열거형 하나로 관리한다: `TITLE, SONG_SELECT, SETTINGS, IMPORT, PRACTICE_EDIT,
   PRACTICE_PLAY, PLAY, RESULTS`. 동시에 두 화면이 활성화되지 않는다.
2. 허용 전환: `TITLE→SONG_SELECT`(앱 로드당 1회) / `SONG_SELECT↔SETTINGS` / `SONG_SELECT↔IMPORT` /
   `SONG_SELECT↔PRACTICE_EDIT` / `SONG_SELECT→PLAY→RESULTS` / `RESULTS→PLAY`(재도전, 동일 곡·
   동일 옵션) / `RESULTS→SONG_SELECT`. `PRACTICE_EDIT↔PRACTICE_PLAY`는 [practice-mode](practice-mode.md)
   소관이다. 목록에 없는 전환(예: `TITLE→SETTINGS`, `PLAY→SONG_SELECT` 직접 이동)은 금지한다 —
   SONG_SELECT를 거치지 않는 화면 이동은 없다.

### 부팅 시퀀스 — MUST

3. 앱 로드 시 데이터 의존 없이 TITLE을 즉시 그린다.
4. TITLE 표시와 동시에 백그라운드 부트스트랩을 실행한다: localStorage에서 키 맵
   ([input-handling](input-handling.md)), 판정 오프셋·볼륨·키 컨피그([settings-screen](settings-screen.md)),
   플레이 옵션([play-options](play-options.md)), 기록([results-records](results-records.md))을 복원하고,
   곡 라이브러리 메타데이터(내장 `index.json` + IndexedDB 임포트 목록, [song-library](song-library.md))를
   로드한다.
5. localStorage 항목이 파싱 불가(손상)면 해당 항목만 기본값으로 대체하고 부팅을 계속한다 — 하나의
   손상된 키가 전체 부팅을 막지 않는다. 기록 손상은 [results-records](results-records.md)의 백업/초기화
   확인 절차를 따른다.
6. SONG_SELECT 진입은 4의 완료를 전제로 한다. 완료 전 첫 제스처가 오면 로딩 표시 후 완료 시
   자동 전환한다.

### 첫 제스처·오디오 언락 — MUST

7. TITLE은 "Press any key"를 표시하고 첫 `keydown`/`click`에서 AudioContext를 생성·resume한다
   ([audio-playback](audio-playback.md)). 언락 성공이 SONG_SELECT 전환 조건 중 하나다.
8. 이후 탭 백그라운드 복귀 등으로 AudioContext가 `suspended`가 되면 다음 사용자 입력에서 자동
   resume을 시도하며, 실패해도 앱을 막지 않는다.

### ESC 처리 — MUST

9. PLAY 중 Escape = 곡 포기: 오디오를 페이드아웃 정지하고([audio-playback](audio-playback.md)와
   동일한 정지 경로) RESULTS로 전환한다. FAILED로 집계하되 조기 종료(포기)임을 화면 문구로
   구분한다 — 기록에 실제로 남길 필드는 [results-records](results-records.md) 소관이다.
10. PRACTICE_PLAY 중 Escape는 [practice-mode](practice-mode.md)를 따라 PRACTICE_EDIT로 복귀한다 —
    본 스펙은 관여하지 않는다.
11. SETTINGS/IMPORT/PRACTICE_EDIT/RESULTS에서 Escape는 SONG_SELECT로 한 단계 복귀한다(화면 자체의
    예외, 예를 들어 [settings-screen](settings-screen.md)의 키 캡처 중 Escape 처리는 해당 스펙이
    정의한다). TITLE에서 Escape는 아무 동작도 하지 않는다.
12. 플레이 중 일시정지는 없다([00-overview](00-overview.md) 비목표) — Escape가 유일한 중단 수단이다.

### DOM/PixiJS 경계 — MUST

13. TITLE/SONG_SELECT/SETTINGS/IMPORT/PRACTICE_EDIT/RESULTS는 DOM, PLAY/PRACTICE_PLAY는 PixiJS
    캔버스로 그린다([playfield-rendering](playfield-rendering.md)). PixiJS 화면 진입 시
    `PIXI.Application`을 생성해 마운트하고, DOM 화면으로 돌아갈 때
    `destroy(true, { children: true, texture: true })`로 파괴한다 — 둘이 동시에 보이지 않는다.
14. PLAY/PRACTICE_PLAY 이탈 시 오디오 노드, 게임플레이 키 리스너([input-handling](input-handling.md)),
    PixiJS 리소스를 모두 해제한다 — 다음 진입이 이전 세션 잔존 상태에 영향받지 않는다.

### 로딩·오류 처리 — MUST

15. SONG_SELECT→PLAY 전환 중 채보·음원 로드 실패 시 SONG_SELECT로 복귀하고 원인 메시지를
    표시한다([song-select](song-select.md) 요구사항 9와 동일 계약).
16. 화면 전환 중에는 로딩 표시로 입력을 일시 차단한다. 실패 시 항상 직전 화면 또는 SONG_SELECT로
    복귀하며 빈 화면·멈춘 상태로 끝나지 않는다. IMPORT 중 오류는 전환 없이 그 자리에 표시한다
    ([song-library](song-library.md), [bms-import](bms-import.md)).

### 키보드 포커스·입력 스코프 — MUST

17. DOM 메뉴는 공통 포커스 모델을 공유한다: 방향키로 포커스 이동, Enter로 활성화, Escape는 위
    표를 따른다([input-handling](input-handling.md) SHOULD 11). 텍스트 입력·키 재할당 캡처 등
    포커스된 위젯이 있으면 그 위젯이 키 이벤트를 우선 소비하고, 전역 내비게이션은 포커스 해제
    전까지 대기한다([settings-screen](settings-screen.md)).
18. 게임플레이 키 캡처(`preventDefault`, [input-handling](input-handling.md))는 PLAY/PRACTICE_PLAY
    진입 시에만 리스너를 부착하고 이탈 즉시 해제한다. 메뉴 화면에는 이 리스너가 없어 브라우저
    기본 동작(Space 스크롤 등)을 막지 않는다.

### SHOULD

19. 화면 전환을 타입이 있는 이벤트/상태 계약(예: `AppEvent` 유니온)으로 노출해, 기록 쓰기·옵션
    변경 같은 기능이 라우팅 로직에 직접 의존하지 않게 한다.
20. 화면 전환 애니메이션(페이드 등)은 300ms 이내로 제한한다.
21. TITLE에 부트스트랩 진행 상태를 짧게 표시한다.

## 수용 기준

- [ ] 새로고침 직후 데이터 로드 없이 TITLE이 즉시 표시된다.
- [ ] localStorage의 기록 JSON을 깨뜨려도 앱이 죽지 않고 SONG_SELECT까지 도달한다.
- [ ] 정의되지 않은 전환(`TITLE→SETTINGS` 등)을 호출하면 상태 기계가 거부한다(단위 테스트).
- [ ] PLAY 중 Escape를 누르면 오디오가 페이드아웃되고 RESULTS 화면에 포기 표시로 도착한다.
- [ ] `PLAY→RESULTS→SONG_SELECT`를 5회 반복해도 PixiJS 캔버스나 AudioContext 노드가 누적되지
      않는다.
- [ ] SONG_SELECT에서 곡 로드 실패를 유도하면 전환 없이 오류 메시지가 표시된다.

## 의존 관계

- 부팅 데이터: [input-handling](input-handling.md), [audio-playback](audio-playback.md),
  [settings-screen](settings-screen.md), [play-options](play-options.md),
  [results-records](results-records.md), [song-library](song-library.md)
- 화면 콘텐츠 소유: [song-select](song-select.md)(SONG_SELECT), [settings-screen](settings-screen.md)
  (SETTINGS), [practice-mode](practice-mode.md)(PRACTICE_EDIT/PRACTICE_PLAY),
  [playfield-rendering](playfield-rendering.md)(PLAY 캔버스), [results-records](results-records.md)(RESULTS)
- 정책 참조: [00-overview](00-overview.md) 비목표(플레이 중 일시정지 없음)

## 미해결 질문

- IMPORT 화면 자체의 레이아웃·내비게이션을 규정하는 전용 스펙이 없다(현재는
  [song-library](song-library.md) 요구사항 7의 짧은 언급뿐). 진행 중 다른 화면으로 이동 시 임포트를
  취소할지 백그라운드로 유지할지도 미정 — [bms-import](bms-import.md)와 조율 필요.
