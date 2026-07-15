# 내부 채보 포맷

> 내부 채보 포맷은 플레이에 필요한 노트·타이밍 데이터를 정의한다.

## 배경

BMS를 직접 플레이하지 않고, 임포트 시 내부 JSON 포맷으로 변환해 사용한다([bms-import](bms-import.md)).
내장 곡도 처음부터 이 포맷으로 제작한다. 게임플레이·렌더링·판정 코드는 이 포맷만 알면 된다.

## 요구사항

### MUST

1. 채보는 JSON으로 직렬화 가능한 단일 객체이며 `formatVersion` 필드(정수, 시작값 1)를 가진다.
2. 메타데이터를 포함한다: 제목, 아티스트, 장르, 표기 레벨(1~12), 난이도 슬롯(`BEGINNER | NORMAL | HYPER | ANOTHER`), 초기 BPM, 최소/최대 BPM, 총 노트 수, 게이지 계산용 `total` 값.
3. 노트 위치는 **비트(beat) 단위 소수**로 기록한다 (마디·분할 개념은 편집 도구의 관심사이고, 저장은 비트 하나로 통일).
4. 레인은 `0 = 스크래치, 1~7 = 건반`의 정수로 표현한다.
5. 타이밍 이벤트를 포함한다:
   - BPM 변경: `{ beat, bpm }` 목록 (첫 항목이 초기 BPM).
   - STOP(스크롤 정지): `{ beat, durationBeats }` 목록.
6. 노트 종류는 `tap`(일반 노트)을 지원한다.
7. 로드 시 타이밍 이벤트로부터 각 노트의 **절대 시각(ms)** 을 계산하는 함수를 제공한다. BPM 변경·STOP을 모두 반영해야 하며, 계산 결과는 판정·렌더링·믹스다운이 공통으로 사용한다.
8. 같은 곡(songId)에 여러 채보(chartId, 난이도별)가 속하는 곡-채보 2계층 구조를 가진다. 곡 레벨에 음원 참조(내장 곡은 URL, 임포트 곡은 IndexedDB 키)와 음원 재생 오프셋(ms)을 둔다.

### SHOULD

9. 차지 노트(CN, 롱노트): `type: 'cn'` + `endBeat`. 판정·렌더링 스펙에서도 CN은 SHOULD로 취급한다.
10. 스키마 검증 함수(로드 시 형식 오류를 명확한 메시지로 보고)를 제공한다.
11. `formatVersion` 증가 시 마이그레이션 훅을 둘 수 있는 로더 구조.

## 데이터 스케치 (규범이 아닌 예시)

```ts
interface Song {
  songId: string;
  title: string; artist: string; genre: string;
  audio: { source: 'builtin' | 'imported'; ref: string; offsetMs: number };
  charts: Chart[];
}

interface Chart {
  formatVersion: 1;
  chartId: string;
  difficulty: 'BEGINNER' | 'NORMAL' | 'HYPER' | 'ANOTHER';
  level: number;                    // 1..12
  total: number;                    // 게이지 회복 총량 (BMS #TOTAL 유래)
  bpm: { init: number; min: number; max: number };
  timing: {
    bpmEvents: { beat: number; bpm: number }[];
    stopEvents: { beat: number; durationBeats: number }[];
  };
  notes: { beat: number; lane: number; type: 'tap' | 'cn'; endBeat?: number }[];
}
```

## 수용 기준

- [ ] BPM 변경이 2회 이상 있는 채보에서 각 노트의 ms 시각이 수기 계산과 일치한다.
- [ ] STOP 구간 동안 비트→시간 변환이 정지 시간만큼 지연된다.
- [ ] 노트 2,000개 채보의 로드+시각 계산이 100ms 이내에 끝난다.
- [ ] 잘못된 JSON(레인 범위 밖, 음수 beat 등)은 로드가 거부되고 원인이 보고된다.

## 의존 관계

- 소비자: [judgement-scoring](judgement-scoring.md), [playfield-rendering](playfield-rendering.md), [audio-playback](audio-playback.md), [practice-mode](practice-mode.md)
- 생산자: [bms-import](bms-import.md), 내장 곡 제작, [practice-mode](practice-mode.md)의 패턴 에디터

## 미해결 질문

- CN(롱노트)을 v1 범위에 포함할지 — 포맷에는 자리를 마련하되 구현 우선순위는 낮음.
