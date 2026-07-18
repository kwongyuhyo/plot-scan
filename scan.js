#!/usr/bin/env node
/**
 * plot-scan — PLOT 데일리 차트 수집기
 *
 * kworb 스포티파이 KR + 유튜브 KR 일간을 가져와서
 *   1) data/ 에 날짜별 CSV 누적 (아카이빙 — 차트는 휘발되므로)
 *   2) 전일 CSV와 diff → 신규 진입·급등·재진입·이탈
 *   3) 워치리스트 매칭
 *   4) brief.md 생성
 *
 * 실행:  node scan.js            (수집 + 브리프)
 *        node scan.js --test     (내장 파서 테스트만)
 *
 * 의존성 0. Node 18+ (내장 fetch).
 * 로컬이든 GitHub Actions든 동일하게 동작.
 */

const fs = require('fs');
const path = require('path');

const SOURCES = [
  {
    key: 'spotify',
    label: 'Spotify KR 일간',
    url: 'https://kworb.net/spotify/country/kr_daily.html',
    // 아티스트 매칭: /artist/[ID].html 링크의 ID로
    idPattern: /artist\/([0-9A-Za-z]{22})\.html/,
  },
  {
    key: 'youtube',
    label: 'YouTube KR 일간',
    url: 'https://kworb.net/youtube/insights/kr_daily.html',
    idPattern: null, // 유튜브는 이름 문자열 매칭
  },
];

const DATA_DIR = path.join(__dirname, 'data');
const WATCHLIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8')
);
const SURGE_MIN = 15;   // P+ 이 값 이상이면 "급등"
const NEW_MAX_POS = 200;

// ── HTML 테이블 파서 (헤더 기반 · 의존성 0) ─────────────────
function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTable(html, idPattern) {
  // kworb은 페이지당 메인 테이블 1개. 가장 행이 많은 테이블을 고른다.
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]);
  if (!tables.length) throw new Error('테이블을 찾지 못함 — kworb 구조 변경 가능성. HTML을 확인할 것.');
  const body = tables.reduce((a, b) =>
    (b.match(/<tr/gi) || []).length > (a.match(/<tr/gi) || []).length ? b : a);

  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  if (rows.length < 2) throw new Error('행이 너무 적음 — 파싱 실패로 간주.');

  // 헤더 행: th 우선, 없으면 첫 행의 td
  let headerCells = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => stripTags(m[1]));
  let start = 1;
  if (!headerCells.length) {
    headerCells = [...rows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
    start = 1;
  }
  const H = headerCells.map(h => h.toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = H.findIndex(h => h === n || h.startsWith(n));
      if (i !== -1) return i;
    }
    return -1;
  };

  const iPos = col('pos', '#');
  const iChg = col('p+', '+', 'change');
  const iTitle = col('artist and title', 'artist', 'video', 'track', 'title');
  const iDays = col('days');
  const iPk = col('pk', 'peak');
  const iStreams = col('streams', 'views');
  const iTotal = col('total');
  if (iPos === -1 || iTitle === -1)
    throw new Error(`필수 컬럼(Pos/Title)을 못 찾음. 헤더: [${headerCells.join(' | ')}]`);

  const out = [];
  for (let r = start; r < rows.length; r++) {
    const cellsRaw = [...rows[r].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (!cellsRaw.length) continue;
    const cells = cellsRaw.map(stripTags);
    const pos = parseInt(cells[iPos], 10);
    if (!Number.isFinite(pos)) continue;

    const rawTitleCell = cellsRaw[iTitle] || '';
    const entry = {
      pos,
      change: iChg !== -1 ? (cells[iChg] || '').trim() : '',
      title: cells[iTitle] || '',
      days: iDays !== -1 ? parseInt(cells[iDays], 10) || null : null,
      peak: iPk !== -1 ? parseInt(cells[iPk], 10) || null : null,
      streams: iStreams !== -1 ? (cells[iStreams] || '').replace(/,/g, '') : '',
      total: iTotal !== -1 ? (cells[iTotal] || '').replace(/,/g, '') : '',
      artistIds: [],
    };
    if (idPattern) {
      entry.artistIds = [...rawTitleCell.matchAll(new RegExp(idPattern.source, 'g'))].map(m => m[1]);
    }
    out.push(entry);
  }
  if (!out.length) throw new Error('데이터 행 0개 — 파싱 실패로 간주.');
  return out;
}

// ── CSV ──────────────────────────────────────────────────
const csvEsc = v => {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
function toCSV(entries) {
  const head = 'pos,change,title,days,peak,streams,total,artistIds';
  const lines = entries.map(e =>
    [e.pos, e.change, e.title, e.days ?? '', e.peak ?? '', e.streams, e.total, e.artistIds.join(';')]
      .map(csvEsc).join(','));
  return [head, ...lines].join('\n') + '\n';
}
function fromCSV(text) {
  const lines = text.trim().split('\n').slice(1);
  return lines.map(line => {
    // 간이 CSV 파서 (따옴표 지원)
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return {
      pos: parseInt(cells[0], 10),
      change: cells[1],
      title: cells[2],
      days: cells[3] ? parseInt(cells[3], 10) : null,
      peak: cells[4] ? parseInt(cells[4], 10) : null,
      streams: cells[5],
      total: cells[6],
      artistIds: cells[7] ? cells[7].split(';') : [],
    };
  });
}

// ── diff · 워치리스트 ────────────────────────────────────
function keyOf(e) { return e.title.toLowerCase(); }

function diff(today, yesterday) {
  const yMap = new Map(yesterday.map(e => [keyOf(e), e]));
  const tKeys = new Set(today.map(keyOf));
  const news = today.filter(e => !yMap.has(keyOf(e)) && e.pos <= NEW_MAX_POS);
  const surges = today.filter(e => {
    const n = parseInt(String(e.change).replace(/[^\-\d]/g, ''), 10);
    return Number.isFinite(n) && n >= SURGE_MIN;
  });
  const reentries = today.filter(e => /re/i.test(String(e.change)));
  const dropped = yesterday.filter(e => !tKeys.has(keyOf(e)) && e.pos <= 100);
  return { news, surges, reentries, dropped };
}

function watchHits(entries, srcKey) {
  const hits = [];
  for (const e of entries) {
    for (const w of WATCHLIST) {
      const byId = srcKey === 'spotify' && w.spotifyId && e.artistIds.includes(w.spotifyId);
      const byName = [w.name, w.eng].filter(Boolean).some(n =>
        e.title.toLowerCase().includes(n.toLowerCase()));
      if (byId || byName) { hits.push({ entry: e, artist: w.name }); break; }
    }
  }
  return hits;
}

// ── 브리프 ───────────────────────────────────────────────
function fmtEntry(e) {
  const bits = [`**${e.pos}위**`, e.title];
  if (e.change) bits.push(`(${e.change})`);
  if (e.days != null) bits.push(`· Days ${e.days}`);
  return bits.join(' ');
}

function section(title, arr, empty) {
  if (!arr.length) return `### ${title}\n${empty}\n`;
  return `### ${title}\n` + arr.map(x => `- ${fmtEntry(x.entry || x)}${x.artist ? `  ← **${x.artist}**` : ''}`).join('\n') + '\n';
}

// ── 분석 레이어 (C-1 태그 · C-2 라우팅) · 전부 순수 함수 ────────
// SPEC.md §2 패턴 참조. 이 도구는 후보·근거까지만 — 선곡·판단은 사람이 한다.
// 조회수·성과를 선곡 입력으로 쓰는 로직은 절대 넣지 않는다.

// 제목 앞 아티스트명 (kworb "Artist - Title" 형식)
function artistOf(title) {
  const s = String(title || '');
  const i = s.indexOf(' - ');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

// 조인용 제목 정규화 (SPEC §4). 괄호군 제거 → 구분자 통일 → 소문자·공백정리.
function normTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[-–—/·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// P+ 필드 해석: NEW / RE / 이동량
function parseChange(change) {
  const s = String(change || '').trim();
  if (/new/i.test(s)) return { kind: 'new', n: null };
  if (/re/i.test(s)) return { kind: 're', n: null };
  const n = parseInt(s.replace(/[^\-\d]/g, ''), 10);
  return { kind: 'move', n: Number.isFinite(n) ? n : 0 };
}

// P3 하락 기울기: Pos===Pk 상승 중, Pos>Pk 하락(한때 N위)
function trajectoryTag(e) {
  if (e.peak == null || e.pos == null) return null;
  if (e.pos === e.peak) return '상승 중 (정점 미도달)';
  if (e.pos > e.peak) return `하락 (한때 ${e.peak}위, −${e.pos - e.peak})`;
  return null;
}

// P2 롱테일 격차: Days≥300 롱테일, Days≤10 신곡
function longTailTag(e) {
  if (e.days == null) return null;
  if (e.days >= 300) return `롱테일 (약 ${Math.round(e.days / 30)}개월)`;
  if (e.days <= 10) return '신곡';
  return null;
}

// C-1: 후보 1건의 해석 태그 3줄 (▸). ctx = {isWatch, artistName, catCount, crossPlatform}
function interpretTags(e, ctx = {}) {
  const lines = [];
  const traj = trajectoryTag(e);
  if (traj) lines.push(traj);
  const lt = longTailTag(e);
  if (lt) lines.push(lt);
  const watch = ctx.isWatch ? (ctx.artistName || '워치리스트 히트') : '워치리스트 ✗';
  const cat = ctx.catCount >= 2 ? `카탈로그 ${ctx.catCount}곡 동시` : '카탈로그 단독';
  const tail = ctx.crossPlatform ? ` · 플랫폼 동반(YouTube도)` : '';
  lines.push(`${watch} · ${cat}${tail}`);
  return lines;
}

// C-2: 후보 1건을 포맷별 섹션으로 라우팅 (한 곡이 여러 섹션 가능 — 배타 아님)
// today = 오늘의 노래 후보(발견) · osms = 오음소 소재(소식)
// 특집 신호(맥락)는 곡 단위가 아니라 카탈로그·플랫폼 그룹으로 별도 렌더.
function routeSong(e, ctx = {}) {
  const c = parseChange(e.change);
  const isWatch = !!ctx.isWatch;
  // 오늘의 노래 후보: 진입 중 신곡·상승 곡 · 또는 워치리스트 히트 & 순위 안정
  const risingNew = e.days != null && e.days <= 60 && e.peak != null && e.pos === e.peak;
  const freshNew = c.kind === 'new' && e.days != null && e.days <= 60;
  const watchStable = isWatch && c.kind === 'move' && Math.abs(c.n) <= 5;
  const today = risingNew || freshNew || watchStable;
  // 오음소 소재: 급등(P+≥15) · 재진입(RE) · Days 긴 곡의 이변
  const surge = c.kind === 'move' && c.n >= 15;
  const reentry = c.kind === 're';
  const oldMove = e.days != null && e.days >= 300 && c.kind === 'move' && Math.abs(c.n) >= 10;
  const osms = surge || reentry || oldMove;
  return { today, osms };
}

// 아티스트별 차트인 곡 수 (P4). 대표 아티스트 = artistIds[0] 우선, 없으면 제목 앞 이름.
function buildCatalog(entries) {
  const counts = new Map();
  for (const e of entries) {
    const key = (e.artistIds && e.artistIds[0]) || artistOf(e.title);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function catKeyOf(e) {
  return (e.artistIds && e.artistIds[0]) || artistOf(e.title);
}

// 제목만 (아티스트 표기 흔들림 대비 폴백 조인용). "Artist - Title" → Title 정규화.
function titleOnly(title) {
  const parts = String(title || '').split(' - ');
  return normTitle(parts.length > 1 ? parts.slice(1).join(' - ') : parts[0]);
}

// P1 괴리 — 플랫폼 교차 crossPlatformGap()
// 제목 정규화 조인(§4). full 매칭 우선, 실패 시 제목-only 유일 매칭으로 폴백(아티스트 표기 차이 흡수).
// 여전히 못 붙은 YouTube 곡 = "대중·영상이 먼저"(조용히 삼키지 않고 표면화).
function crossPlatformGap(spotify, youtube) {
  const spFull = new Map();      // normTitle → entry
  const spByTitle = new Map();   // titleOnly → [entries]
  for (const e of spotify) {
    const f = normTitle(e.title);
    if (!spFull.has(f)) spFull.set(f, e);
    const t = titleOnly(e.title);
    if (!spByTitle.has(t)) spByTitle.set(t, []);
    spByTitle.get(t).push(e);
  }
  const both = [], youtubeOnly = [], matchedSpTitles = new Set();
  let full = 0, fallback = 0;
  for (const y of youtube) {
    let sp = spFull.get(normTitle(y.title));
    if (sp) { full++; }
    else {
      const cand = spByTitle.get(titleOnly(y.title)) || [];
      if (cand.length === 1) { sp = cand[0]; fallback++; }  // 유일할 때만(모호하면 미매칭 처리)
    }
    if (sp) { both.push({ sp, ytPos: y.pos }); matchedSpTitles.add(sp.title); }
    else youtubeOnly.push(y);
  }
  return {
    both, youtubeOnly, matchedSpTitles,
    stats: { ytTotal: youtube.length, matched: both.length, full, fallback, unmatched: youtubeOnly.length },
  };
}

// 후보 1건을 태그와 함께 렌더
function renderCandidate(e, ctx) {
  let out = `- ${fmtEntry(e)}`;
  for (const t of interpretTags(e, ctx)) out += `\n  ▸ ${t}`;
  return out;
}

// ── 메인 ─────────────────────────────────────────────────
async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (plot-scan; personal chart archiver)' },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function dateStr(d = new Date()) {
  // KST 기준 날짜
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}
function prevDateStr(days = 1) {
  return dateStr(new Date(Date.now() - days * 86400 * 1000));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const today = dateStr();

  // ── 1) 수집·아카이빙 + 소스별 diff/워치리스트 확보 ──────────
  const srcData = {}; // key → { label, entries, prevDay, diff, hits }
  for (const src of SOURCES) {
    const csvPath = d => path.join(DATA_DIR, `${src.key}_${d}.csv`);
    process.stdout.write(`[${src.key}] fetch... `);
    const html = await fetchHTML(src.url);
    const entries = parseTable(html, src.idPattern);
    fs.writeFileSync(csvPath(today), toCSV(entries));
    console.log(`${entries.length}행 저장`);

    let prev = null, prevDay = null;
    for (let back = 1; back <= 7; back++) {
      const p = csvPath(prevDateStr(back));
      if (fs.existsSync(p)) { prev = fromCSV(fs.readFileSync(p, 'utf8')); prevDay = prevDateStr(back); break; }
    }
    srcData[src.key] = {
      label: src.label,
      entries,
      prevDay,
      diff: prev ? diff(entries, prev) : null,
      hits: watchHits(entries, src.key),
    };
  }

  const brief = buildBrief(srcData, today);
  fs.writeFileSync(path.join(__dirname, 'brief.md'), brief);
  console.log(`brief.md 생성 완료 (${today})`);
}

// brief.md 문자열 생성 — 수집과 분리(오프라인 재생성·테스트 가능). srcData = key→{label,entries,prevDay,diff,hits}
function buildBrief(srcData, today) {
  let brief = `# PLOT 데일리 브리프 — ${today}\n\n`;
  brief += `> 급등 기준: 전일 대비 +${SURGE_MIN} 이상 · 데이터: kworb (24~48h 지연 가능)\n\n`;

  // ── 2) 분석 컨텍스트 (Spotify = Days/Pk/artistIds 있는 주 분석원) ──
  const sp = srcData.spotify || { entries: [], hits: [], diff: null };
  const catalog = buildCatalog(sp.entries);            // P4 아티스트별 곡 수
  const watchByKey = new Map();                        // entry title → artist명
  for (const h of sp.hits) watchByKey.set(h.entry.title, h.artist);
  const ytEntries = srcData.youtube?.entries || [];
  const cpg = crossPlatformGap(sp.entries, ytEntries); // P1 플랫폼 교차 괴리

  const ctxOf = (e) => ({
    isWatch: watchByKey.has(e.title),
    artistName: watchByKey.get(e.title),
    catCount: catalog.get(catKeyOf(e)) || 1,
    crossPlatform: cpg.matchedSpTitles.has(e.title),
  });

  // 후보 풀 = 워치리스트 히트 ∪ diff(신규·급등·재진입). 제목 기준 중복 제거.
  const poolMap = new Map();
  const addPool = (e) => { if (e && !poolMap.has(e.title)) poolMap.set(e.title, e); };
  sp.hits.forEach(h => addPool(h.entry));
  if (sp.diff) { sp.diff.news.forEach(addPool); sp.diff.surges.forEach(addPool); sp.diff.reentries.forEach(addPool); }
  const pool = [...poolMap.values()];

  // ── 3) C-2 라우팅 (중복 노출 OK) ────────────────────────
  const today3 = [], osms3 = [];
  for (const e of pool) {
    const r = routeSong(e, ctxOf(e));
    if (r.today) today3.push(e);
    if (r.osms) osms3.push(e);
  }
  today3.sort((a, b) => a.pos - b.pos);
  osms3.sort((a, b) => (parseChange(b.change).n || 0) - (parseChange(a.change).n || 0) || a.pos - b.pos);

  const renderList = (arr, cap = 15) => arr.slice(0, cap).map(e => renderCandidate(e, ctxOf(e))).join('\n');
  const capNote = (arr, cap = 15) => arr.length > cap ? `\n_…외 ${arr.length - cap}건 (원자료 참조)_` : '';

  brief += `> 수집: Spotify KR ${sp.entries.length}곡 · YouTube KR ${(srcData.youtube?.entries || []).length}곡`;
  brief += sp.prevDay ? ` · 비교 기준 ${sp.prevDay}\n\n` : ` · 첫 수집(내일부터 diff)\n\n`;

  brief += `## 오늘의 노래 후보\n_발견 — 진입 중 신곡·상승 곡·워치리스트 안정 히트_\n\n`;
  brief += (today3.length ? renderList(today3) + capNote(today3) : '_해당 없음_') + '\n\n';

  brief += `## 오음소 소재\n_소식 — 급등·재진입·오래된 곡의 이변_\n\n`;
  brief += (osms3.length ? renderList(osms3) + capNote(osms3) : '_해당 없음_') + '\n\n';

  // 특집 신호 = P4 카탈로그 다곡 + P1 플랫폼 동반 (곡 단위 아님)
  brief += `## 특집 신호\n_맥락 — 카탈로그 다곡·플랫폼 괴리_\n\n`;
  // 워치리스트(=PLOT 결) 아티스트 곡 제목 집합 — 카탈로그 그룹 우선순위에 쓴다
  const watchTitles = new Set(sp.hits.map(h => h.entry.title));
  const catGroups = [];
  for (const [key, n] of catalog) {
    if (n < 2) continue;
    const songs = sp.entries.filter(e => catKeyOf(e) === key).sort((a, b) => a.pos - b.pos);
    const isWatch = songs.some(s => watchTitles.has(s.title));
    catGroups.push({ name: artistOf(songs[0].title), n, songs, isWatch });
  }
  // PLOT 결 아티스트 먼저, 그다음 곡 수 → 최상위 순위. 캡 15(나머지는 카운트로만).
  catGroups.sort((a, b) => (b.isWatch - a.isWatch) || (b.n - a.n) || (a.songs[0].pos - b.songs[0].pos));
  const CAT_CAP = 15;
  if (catGroups.length) {
    brief += catGroups.slice(0, CAT_CAP).map(g =>
      `- **${g.name}** — 카탈로그 ${g.n}곡 동시 차트인 (${g.songs.map(s => s.pos + '위').join('·')})${g.isWatch ? '  ← **워치리스트**' : ''}\n  ▸ 히트곡 하나 아닌 카탈로그 소비 = 팬덤 아닌 취향의 증거`
    ).join('\n') + '\n';
    if (catGroups.length > CAT_CAP) {
      const rest = catGroups.slice(CAT_CAP).map(g => `${g.name}(${g.n})`).join(' · ');
      brief += `_…외 ${catGroups.length - CAT_CAP}곡군: ${rest}_\n`;
    }
    brief += '\n';
  } else {
    brief += '_카탈로그 다곡 없음_\n\n';
  }
  // P1 플랫폼 교차 괴리 (제목 정규화+제목폴백 조인)
  const ytWatch = new Set((srcData.youtube?.hits || []).map(h => h.entry.title));
  brief += `_조인: YouTube ${cpg.stats.ytTotal}곡 중 ${cpg.stats.matched}곡 Spotify 매칭(정확 ${cpg.stats.full}·제목폴백 ${cpg.stats.fallback}) · 미매칭 ${cpg.stats.unmatched}곡은 아래 'YouTube 선행'_\n\n`;

  // 둘 다 = 진짜 확산 → 특집. 워치리스트(PLOT 결) 우선, 캡 12.
  const bothRows = cpg.both
    .map(b => ({ ...b, isWatch: watchTitles.has(b.sp.title) }))
    .sort((a, b) => (b.isWatch - a.isWatch) || (a.sp.pos - b.sp.pos));
  if (bothRows.length) {
    brief += `**플랫폼 동반 (Spotify＋YouTube · 진짜 확산 → 특집)**\n` +
      bothRows.slice(0, 12).map(b => `- **${b.sp.title}** — SP ${b.sp.pos}위 · YT ${b.ytPos}위${b.isWatch ? '  ← **워치리스트**' : ''}`).join('\n') + '\n';
    if (bothRows.length > 12) brief += `_…외 ${bothRows.length - 12}곡_\n`;
    brief += '\n';
  }

  // YouTube만 = 대중·영상이 먼저 → MV/라이브클립 앵글
  if (cpg.youtubeOnly.length) {
    brief += `**YouTube 선행 (Spotify 200위 밖 · 대중·영상이 먼저 → MV/라이브클립 앵글)**\n` +
      cpg.youtubeOnly.sort((a, b) => a.pos - b.pos).map(y => {
        const chg = y.change && y.change !== '=' ? ` (${y.change})` : '';
        return `- ${y.title} — YT ${y.pos}위${chg}${ytWatch.has(y.title) ? '  ← **워치리스트**' : ''}`;
      }).join('\n') + '\n\n';
  }

  // ── 4) 원자료 부록 (판단 드릴다운용 — 아무것도 버리지 않는다) ──
  brief += `---\n## 원자료\n\n`;
  for (const src of SOURCES) {
    const d = srcData[src.key];
    brief += `### ${d.label} (${d.entries.length}곡)\n`;
    if (d.diff) {
      brief += `_비교 기준: ${d.prevDay}_\n`;
      brief += section('신규 진입', d.diff.news.slice(0, 15), '없음');
      brief += section(`급등 (+${SURGE_MIN}↑)`, d.diff.surges.slice(0, 15), '없음');
      brief += section('재진입 (RE)', d.diff.reentries.slice(0, 10), '없음');
      brief += section('이탈 (전일 100위 내)', d.diff.dropped.slice(0, 10), '없음');
    } else {
      brief += `_첫 수집 — 내일부터 diff가 나옵니다._\n`;
    }
    brief += section(`워치리스트 히트 (${d.hits.length})`, d.hits, '없음');
    brief += '\n';
  }
  brief += `---\n괴리 읽기: Spotify O/멜론 X → 오늘의 노래 · Shorts O/Top X → 이슈 · 전 차트 동반 → 특집. 자세한 건 운영 루틴 v10 §5-2.\n`;
  return brief;
}

// ── 내장 테스트 ──────────────────────────────────────────
function test() {
  const sample = `
<html><body><table>
<tr><th>Pos</th><th>P+</th><th>Artist and Title</th><th>Days</th><th>Pk</th><th>(x?)</th><th>Streams</th><th>Streams+</th><th>7Day</th><th>7Day+</th><th>Total</th></tr>
<tr><td>1</td><td>+2</td><td><a href="../artist/5wVJpXzuKV6Xj7Yhsf2uYx.html">한로로</a> - <a href="../track/abc.html">Landing in Love</a></td><td>330</td><td>1</td><td>(x3)</td><td>412,345</td><td>+1,234</td><td>2,880,000</td><td>+5,000</td><td>55,000,000</td></tr>
<tr><td>2</td><td>NEW</td><td><a href="../artist/4FBKTurCVdtC6Fq8mSQgj8.html">Raf Sandou</a> - Whenever</td><td>1</td><td>2</td><td></td><td>300,000</td><td></td><td>300,000</td><td></td><td>300,000</td></tr>
<tr><td>3</td><td>+18</td><td>어떤가수 - "쉼, 표" 그리고</td><td>45</td><td>3</td><td></td><td>200,000</td><td>+90,000</td><td>900,000</td><td></td><td>1,000,000</td></tr>
</table></body></html>`;
  const rows = parseTable(sample, SOURCES[0].idPattern);
  console.assert(rows.length === 3, '행 수');
  console.assert(rows[0].pos === 1 && rows[0].days === 330, '필드 파싱');
  console.assert(rows[0].artistIds[0] === '5wVJpXzuKV6Xj7Yhsf2uYx', 'ID 추출');
  console.assert(rows[1].change === 'NEW', 'NEW 플래그');

  const csv = toCSV(rows);
  const back = fromCSV(csv);
  console.assert(back.length === 3 && back[2].title.includes('"쉼, 표"'), 'CSV 왕복(따옴표·쉼표)');

  const d = diff(rows, [rows[0]]); // 어제는 1곡만 있었다고 가정
  console.assert(d.news.length === 2, 'diff 신규');
  console.assert(d.surges.length === 1 && d.surges[0].pos === 3, 'diff 급등');

  const hits = watchHits(rows, 'spotify');
  console.assert(hits.length === 2, '워치리스트 (한로로 ID + Raf Sandou 이름)');

  // ── 분석 레이어 (C-1 태그 · C-2 라우팅) ──
  console.assert(parseChange('+18').n === 18 && parseChange('+18').kind === 'move', 'parseChange 이동');
  console.assert(parseChange('NEW').kind === 'new', 'parseChange NEW');
  console.assert(parseChange('RE').kind === 're', 'parseChange RE');
  console.assert(parseChange('=').kind === 'move' && parseChange('=').n === 0, 'parseChange =');

  console.assert(trajectoryTag({ pos: 1, peak: 1 }).includes('상승 중'), 'P3 상승');
  console.assert(/하락 .*한때 1위, −9/.test(trajectoryTag({ pos: 10, peak: 1 })), 'P3 하락');
  console.assert(longTailTag({ days: 330 }).includes('롱테일') && longTailTag({ days: 330 }).includes('11개월'), 'P2 롱테일');
  console.assert(longTailTag({ days: 5 }) === '신곡', 'P2 신곡');
  console.assert(longTailTag({ days: 100 }) === null, 'P2 중간(태그없음)');

  console.assert(catKeyOf(rows[0]) === '5wVJpXzuKV6Xj7Yhsf2uYx', '카탈로그 키(ID)');
  console.assert(buildCatalog(rows).get('5wVJpXzuKV6Xj7Yhsf2uYx') === 1, 'P4 카탈로그 카운트');
  console.assert(normTitle('한로로 - Landing in Love (feat. X)') === '한로로 landing in love', '제목 정규화');

  console.assert(routeSong(rows[0], { isWatch: true, catCount: 1 }).today === true, '라우팅: 워치안정→오늘의노래');
  console.assert(routeSong(rows[2], { isWatch: false, catCount: 1 }).osms === true, '라우팅: 급등→오음소');
  console.assert(routeSong(rows[1], { isWatch: true, catCount: 1 }).today === true, '라우팅: 신곡NEW→오늘의노래');
  const tags = interpretTags(rows[0], { isWatch: true, artistName: '한로로', catCount: 5, crossPlatform: false });
  console.assert(tags.some(t => t.includes('카탈로그 5곡')) && tags.some(t => t.includes('한로로')), 'C-1 태그 조립');

  // ── P1 플랫폼 교차 괴리 ──
  console.assert(titleOnly('한로로 - Landing in Love') === 'landing in love', 'titleOnly 분리');
  const cpg1 = crossPlatformGap(rows, [
    { title: '한로로 - Landing in Love', pos: 5, change: '=' },  // full 매칭
    { title: 'Nobody - Ghost Song', pos: 9, change: '=' },        // 미매칭 → YouTube만
  ]);
  console.assert(cpg1.both.length === 1 && cpg1.stats.full === 1, 'P1 full 매칭');
  console.assert(cpg1.youtubeOnly.length === 1 && cpg1.youtubeOnly[0].pos === 9, 'P1 YouTube만');
  console.assert(cpg1.matchedSpTitles.has('한로로 - Landing in Love'), 'P1 매칭 제목 집합');
  const cpg2 = crossPlatformGap(rows, [{ title: 'HANRORO - Landing in Love', pos: 5, change: '=' }]); // 표기 다름 → 제목폴백
  console.assert(cpg2.stats.full === 0 && cpg2.stats.fallback === 1 && cpg2.both.length === 1, 'P1 제목폴백(표기 흔들림)');

  console.log('테스트 통과 ✓  (파서·CSV 왕복·diff·워치리스트 + 분석 레이어 C-1/C-2 + P1 괴리)');
}

if (require.main === module) {
  if (process.argv.includes('--test')) test();
  else main().catch(e => { console.error('실패:', e.message); process.exit(1); });
}

module.exports = {
  parseTable, toCSV, fromCSV, diff, watchHits,
  parseChange, trajectoryTag, longTailTag, interpretTags, routeSong,
  buildCatalog, catKeyOf, artistOf, normTitle, buildBrief,
};
