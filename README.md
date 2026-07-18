# plot-scan

PLOT 데일리 차트 수집기. kworb 스포티파이 KR + 유튜브 KR 일간을 매일 가져와서
CSV로 아카이빙하고, 전일 대비 diff(신규 진입·급등·재진입·이탈)와
워치리스트(35명) 히트를 `brief.md` 한 장으로 만든다.

> 왜 만들었나: 차트는 휘발된다 — kworb의 오늘 화면은 내일 사라진다.
> 트랙 레코드·롱테일 특집이 성립하려면 시계열이 쌓여 있어야 한다.
> (운영 루틴 문서 v10 §8 아카이빙, §5-B 참조)

## 구조

```
plot-scan/
├── scan.js                     # 전부 이 파일 하나. 의존성 0 (Node 18+)
├── watchlist.json              # 아티스트 35명 (이름·영문·Spotify ID)
├── .github/workflows/scan.yml  # 매일 KST 07:30 자동 실행
├── data/                       # 날짜별 CSV 누적 (자동 생성) ← 이게 자산
└── brief.md                    # 오늘의 브리프 (자동 생성)
```

## 로컬 실행

```bash
node scan.js          # 수집 + brief.md 생성
node scan.js --test   # 파서·diff·워치리스트 내장 테스트
cat brief.md
```

## GitHub Actions 세팅 (맥북 꺼져 있어도 돌게)

1. GitHub에서 새 저장소 생성 (private 권장)
2. 이 폴더를 푸시:
   ```bash
   cd plot-scan
   git init && git add -A && git commit -m "init"
   git remote add origin git@github.com:<계정>/plot-scan.git
   git push -u origin main
   ```
3. 끝. 매일 KST 07:30에 서버가 수집하고 data/·brief.md를 자동 커밋한다.
4. 아침에 보는 법: 저장소의 brief.md를 열거나, 로컬에서 `git pull && cat brief.md`
5. 수동 실행: 저장소 → Actions → daily-scan → Run workflow

## ⚠ 첫 실행 때 반드시 확인 (Claude Code에게 시킬 일)

파서는 kworb의 현재 HTML 구조(헤더 기반)로 짰지만, **실제 페이지로 검증한 적이
없다** — 만든 환경에서 kworb 접근이 막혀 있었다. 첫 실행 후:

1. `node scan.js` 돌리고 `data/spotify_*.csv` 열어서 행 수(~200)·제목·Days가
   제대로 들어왔는지 눈으로 확인
2. 깨져 있으면 Claude Code에 지시:
   "scan.js의 parseTable이 kworb 실제 HTML과 안 맞아. curl로
   https://kworb.net/spotify/country/kr_daily.html 받아서 구조 보고 고쳐줘.
   node scan.js --test 통과 유지."
3. 유튜브 쪽(kr_daily)은 컬럼 구성이 다를 수 있음 — 같은 방식으로 확인

## 조정 포인트

- `SURGE_MIN` (기본 15): 급등 판정 기준. 노이즈가 많으면 올린다
- `watchlist.json`: 아티스트 추가는 한 줄 —
  `{"name":"이름","eng":"영문","spotifyId":"22자ID"}`
  ID는 kworb 차트에서 아티스트명 클릭 → URL의 /artist/ 뒤
- 크론 시각: `.github/workflows/scan.yml`의 cron (UTC 기준, KST-9)

## 이후 확장 (지금 하지 말 것 — 운영 루틴 v10 §5-8 순서)

- [ ] 오늘의 노래 120곡 소급 대조 스크립트 (`plot-retro`) — 실행표 5번
- [ ] 괴리 자동 감지 (Spotify↔YouTube 교차) — 8월 W6 issue-find에서
- [ ] 텔레그램 발송 — 봇과는 파일로만 연결 (통합 금지: 발행 인프라와 분리)
