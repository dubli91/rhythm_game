# 내장 곡 콘텐츠

> 내장 곡 콘텐츠는 앱과 함께 배포되는 오리지널 곡·채보 자산의 구성·라이선스·제작 파이프라인을 정의한다.

## 배경

[song-library](song-library.md) MUST 1·3은 내장 곡을 `songs/index.json` + 채보 JSON + 음원(ogg)의
정적 자산으로, 최소 3곡 이상 배포하도록 요구한다. [chart-format](chart-format.md)은 "내장 곡 제작"을
채보 생산자로 언급한다. 하지만 어떤 곡을 몇 개·어떤 난이도로 배포할지, 음원 라이선스 확보 방법,
채보 제작·검증 절차는 어느 스펙에도 없다. 본 스펙이 그 공백을 채운다.

## 요구사항

### 곡 구성 — MUST

1. 오리지널 곡 3곡 이상. 난이도 스펙트럼 커버: 저레벨(표기 1~4)·중레벨(5~8)·고레벨(9~12) 각 1곡 이상.
2. 각 곡은 [chart-format](chart-format.md) 난이도 슬롯 2개 이상(NORMAL/HYPER/ANOTHER 등)을 가진다.
3. 최소 1개 채보는 BPM 변경 2회 이상 + STOP 이벤트 1회 이상 포함 — 타이밍 계산
   ([chart-format](chart-format.md) MUST 5·7)을 실사용 경로로 검증한다.
4. 최소 1개 채보는 BPM 변경·STOP 없는 단일 BPM — 수직 슬라이스 기준 채보로 쓴다.

### 라이선스 — MUST

5. 음원은 자체 창작곡 또는 CC0/영리 재배포 허용 퍼미시브 라이선스만 사용한다(저작권 있는 기존
   게임 음악 금지). 곡별 저작자·라이선스·출처를 `index.json`에 기록한다.

### 저장 구조 — MUST

6. `public/songs/` 배치: `index.json`(카탈로그) + `<songId>/chart-<difficulty>.json` +
   `<songId>/audio.ogg`.
7. `index.json` 곡 엔트리 필드: `songId`, `title`, `artist`, `genre`, `bpm: { min, max }`,
   `charts: [{ chartId, difficulty, level, noteCount }]`, `audio`(경로), `offsetMs`,
   `preview: { startMs, durationMs }`, `license`.
8. `songId`·`chartId`는 [results-records](results-records.md) SHOULD 12와 동일하게 결정적 생성
   (제목+아티스트 해시)한다. 재빌드해도 같은 ID가 나와야 로컬 기록이 유지된다.

### 오디오 — MUST

9. ogg vorbis, 44.1kHz 스테레오, 피크 노멀라이즈(≈ -1dBFS, [bms-import](bms-import.md) 믹스다운
   기준과 동일). 음원의 실질 시작 지점을 `offsetMs`로 기록하고 재생·채보 타이밍의 기준으로 삼는다.

### 채보 제작 — MUST

10. 기본 제작 방식은 내부 [chart-format](chart-format.md) JSON 수기 작성이다(연습 세션 그리드
    에디터나 자체 BMS를 [bms-import](bms-import.md)로 변환 후 내보내는 경로도 배제하지 않음).
11. 배포 채보는 모두 [chart-format](chart-format.md) SHOULD 10 스키마 검증기와 beat→ms 변환
    (MUST 7)을 경고 없이 통과해야 한다.
12. 유닛 테스트가 `public/songs/` 하위 모든 채보를 로드해 스키마 검증·beat→ms 변환을 수행하고,
    실패·경고 시 테스트가 실패한다.

### 프리로드 — MUST

13. 앱 시작 시 `index.json`만 로드한다. 채보 JSON·`audio.ogg`는 곡 결정 시(플레이 직전)까지
    요청하지 않는다 — [song-library](song-library.md) MUST 2를 내장 곡 배치에 적용한 구체 조건.

### SHOULD

14. `scripts/` 검증 스크립트(npm script): 모든 내장 채보와 `index.json`의 정합성 점검
    (`noteCount` 일치, 참조 파일 존재 여부).
15. CN([chart-format](chart-format.md) SHOULD 9) 구현 후, 내장 곡 1곡의 채보에 쇼케이스로 CN을 포함.

## 수용 기준

- [ ] 내장 곡 3곡 이상, 각각 난이도 슬롯 2개 이상, 저/중/고 레벨(1-4/5-8/9-12)에 각 1곡 이상.
- [ ] 최소 1개 채보에 BPM 변경 2회 이상 + STOP 1회 이상, 최소 1개 채보는 BPM 변경·STOP 없음.
- [ ] `index.json`의 모든 곡에 라이선스·저작자 정보가 있고, 저작권 있는 게임 음악이 없음.
- [ ] 모든 `audio.ogg`가 ogg vorbis·44.1kHz·스테레오, 피크 -1dBFS 이하.
- [ ] 유닛 테스트가 모든 내장 채보에 대해 스키마 검증·beat→ms 변환을 경고 없이 통과.
- [ ] 동일 제목·아티스트로 `songId`/`chartId`를 재생성하면 항상 같은 값이 나옴.
- [ ] 앱 시작 직후 네트워크 요청에 `index.json`만 나타나고, 채보·오디오는 곡 선택 전까지 없음.

## 의존 관계

- 요구 출처: [song-library](song-library.md) MUST 1·3, [chart-format](chart-format.md) "내장 곡 제작"
- 준수: [chart-format](chart-format.md) 채보 스키마·타이밍 계산, [results-records](results-records.md)
  SHOULD 12 결정적 ID, [bms-import](bms-import.md) 오디오 정규화 기준
- 소비자: [song-select](song-select.md)(카탈로그·난이도 표시), [audio-playback](audio-playback.md)
  (음원 로드·`offsetMs`)

## 미해결 질문

- 오리지널 곡 작곡 주체(자체 작곡 vs CC0 라이브러리 큐레이션) 미정.
- 구체적 곡 제목·아티스트명·장르 배분은 제작 단계에서 확정.
