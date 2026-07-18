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
  let brief = `# PLOT 데일리 브리프 — ${today}\n\n`;
  brief += `> 급등 기준: 전일 대비 +${SURGE_MIN} 이상 · 데이터: kworb (24~48h 지연 가능)\n\n`;

  for (const src of SOURCES) {
    const csvPath = d => path.join(DATA_DIR, `${src.key}_${d}.csv`);
    process.stdout.write(`[${src.key}] fetch... `);
    const html = await fetchHTML(src.url);
    const entries = parseTable(html, src.idPattern);
    fs.writeFileSync(csvPath(today), toCSV(entries));
    console.log(`${entries.length}행 저장`);

    brief += `## ${src.label} (${entries.length}곡 수집)\n\n`;

    // 전일 (없으면 최대 7일 소급 탐색 — 빈 날 허용)
    let prev = null, prevDay = null;
    for (let back = 1; back <= 7; back++) {
      const p = csvPath(prevDateStr(back));
      if (fs.existsSync(p)) { prev = fromCSV(fs.readFileSync(p, 'utf8')); prevDay = prevDateStr(back); break; }
    }

    if (prev) {
      const { news, surges, reentries, dropped } = diff(entries, prev);
      brief += `_비교 기준: ${prevDay}_\n\n`;
      brief += section('신규 진입', news.slice(0, 15), '없음');
      brief += section(`급등 (+${SURGE_MIN}↑)`, surges.slice(0, 15), '없음');
      brief += section('재진입 (RE)', reentries.slice(0, 10), '없음');
      brief += section('이탈 (전일 100위 내)', dropped.slice(0, 10), '없음');
    } else {
      brief += `_첫 수집 — 내일부터 diff가 나옵니다._\n\n`;
    }

    const hits = watchHits(entries, src.key);
    brief += section(`워치리스트 히트 (${hits.length})`, hits, '없음');
    brief += '\n';
  }

  brief += `---\n괴리 읽기: Spotify O/멜론 X → 오늘의 노래 · Shorts O/Top X → 이슈 · 전 차트 동반 → 특집. 자세한 건 운영 루틴 v10 §5-2.\n`;
  fs.writeFileSync(path.join(__dirname, 'brief.md'), brief);
  console.log(`brief.md 생성 완료 (${today})`);
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
  console.log('테스트 통과 ✓  (파서·CSV 왕복·diff·워치리스트)');
}

if (process.argv.includes('--test')) test();
else main().catch(e => { console.error('실패:', e.message); process.exit(1); });
