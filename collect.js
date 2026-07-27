#!/usr/bin/env node
/**
 * collect.js — plot-scan 소스 확장 수집기
 *
 * 왜 필요한가:
 *   클라우드 예약 브리프 세션의 WebFetch는 RSS/Atom을 판독하지 못한다(전부 binary로 옴).
 *   그리고 raw.githubusercontent를 하루 묵은 캐시로 준다.
 *   → GitHub Actions(진짜 Node)가 대신 수집해서 레포에 커밋하고,
 *     브리프는 `git clone --depth 1` 로 받아 로컬에서 읽는다. 캐시도 없고 파싱도 정확하다.
 *
 * 산출물:
 *   data/feeds/YYYY-MM-DD.json  — 원본 아카이브(항목 전체)
 *   feeds.md                    — 브리프가 읽는 요약. T2 슬롯별로 정렬돼 있다.
 *   data/titles/<key>.json      — 국내 매체 제목 스냅샷(다음 실행의 diff 기준)
 *
 * 실행: node collect.js
 * 의존성 0. Node 18+ (내장 fetch).
 *
 * 설계 원칙 — 실패 허용:
 *   소스 하나가 죽어도 절대 전체를 멈추지 않는다. 실패는 기록하고 나머지로 계속한다.
 *   (scan.js는 차트가 핵심이라 파싱 실패 시 죽지만, 이쪽은 보조 소스라 반대다.)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const FEED_DIR = path.join(DATA, 'feeds');
const TITLE_DIR = path.join(DATA, 'titles');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const L = CFG._limits;

const UA = 'Mozilla/5.0 (compatible; plot-scan/1.0; +https://github.com/kwongyuhyo/plot-scan)';

function dateStr(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 429는 재시도로 대부분 풀린다. Reddit·힙합플레이야가 Actions IP에 레이트리밋을 건다(실측).
// 백오프는 8s → 20s. 하루 1회 배치라 최악 30초 추가는 무의미한 비용이다.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BACKOFF = [8000, 20000];

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), L.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
        'accept-language': 'ko,en;q=0.8',
        'cache-control': 'no-cache',
      },
      redirect: 'follow',
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url) {
  let last;
  for (let i = 0; i <= BACKOFF.length; i++) {
    try {
      return await fetchOnce(url);
    } catch (e) {
      last = e;
      // 429/503만 재시도한다. 403·404는 재시도해봐야 똑같다.
      if (![429, 503].includes(e.status) || i === BACKOFF.length) throw e;
      process.stdout.write(`(${e.status} 재시도 ${i + 1}) `);
      await sleep(BACKOFF[i]);
    }
  }
  throw last;
}

// ── XML/HTML 유틸 ────────────────────────────────────────
const unCDATA = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

const decodeEnt = s =>
  unCDATA(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

// 순서가 중요하다: CDATA를 먼저 벗기지 않으면 `<![CDATA[...]]>` 통째가 태그로 인식돼 내용이 날아간다.
const stripTags = s => decodeEnt(unCDATA(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

// Atom은 <link href="..."/> 형태라 별도 처리
function linkOf(block) {
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return stripTags(rss[1]);
  const atom = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? decodeEnt(atom[1]) : '';
}

// ── RSS / Atom 파싱 ──────────────────────────────────────
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const desc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const d = pub ? new Date(pub) : null;
    return {
      title: tag(b, 'title'),
      url: linkOf(b),
      published: d && !isNaN(d) ? d.toISOString().slice(0, 10) : null,
      summary: desc.slice(0, 400),
    };
  }).filter(i => i.title);
}

function withinDays(item, days) {
  if (!item.published) return true; // 날짜 없으면 버리지 않는다 — 판단은 브리프가
  const age = (Date.now() - new Date(item.published).getTime()) / 86400000;
  return age <= days;
}

// ── 국내 매체 제목 스냅샷 + diff ─────────────────────────
function extractTitles(html, linkPattern) {
  // linkPattern은 **선택**이다. 없으면 모든 링크에서 제목을 뽑는다.
  // 새 매체를 붙일 때 URL 구조를 몰라도 일단 시도해볼 수 있게 하려는 것 —
  // 길이 필터(5~120자)와 중복 제거가 대부분의 노이즈를 걸러준다.
  const pat = linkPattern ? `(?:${linkPattern})` : '';
  // linkPattern이 캡처 그룹을 포함할 수 있으므로 제목은 **named group**으로 잡는다.
  // (그러지 않으면 m[1]이 linkPattern의 그룹을 가리켜 제목 대신 URL 조각이 나온다 — 실제로 겪은 버그)
  const re = new RegExp(
    `<a[^>]+href=["'][^"']*${pat}["'][^>]*>(?<title>[\\s\\S]*?)<\\/a>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const t = stripTags(m.groups.title);
    if (t.length >= 5 && t.length <= 120) out.push(t);
  }
  return [...new Set(out)].slice(0, L.titlesPerSource);
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── main ─────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(FEED_DIR, { recursive: true });
  fs.mkdirSync(TITLE_DIR, { recursive: true });
  const today = dateStr();

  const out = { date: today, rss: {}, titles: {}, failures: [] };

  // 1) RSS
  let first = true;
  for (const src of CFG.rss) {
    if (!first) await sleep(L.fetchDelayMs || 1500);
    first = false;
    process.stdout.write(`[rss:${src.key}] `);
    try {
      const xml = await fetchText(src.url);
      const items = parseFeed(xml)
        .filter(i => withinDays(i, L.rssMaxAgeDays))
        .slice(0, L.rssItemsPerSource);
      out.rss[src.key] = { label: src.label, track: src.track, count: items.length, items };
      console.log(`${items.length}건`);
    } catch (e) {
      out.failures.push({ key: src.key, kind: 'rss', error: String(e.message || e) });
      console.log(`실패 — ${e.message || e}`);
    }
  }

  // 2) 국내 매체 제목 diff
  for (const src of CFG.titles) {
    await sleep(L.fetchDelayMs || 1500);
    process.stdout.write(`[titles:${src.key}] `);
    const snapPath = path.join(TITLE_DIR, `${src.key}.json`);
    try {
      const html = await fetchText(src.url);
      const titles = extractTitles(html, src.linkPattern);
      if (!titles.length) throw new Error('제목 0건 — 셀렉터 확인 필요');
      const prev = readJSON(snapPath, { titles: [] });
      const prevSet = new Set(prev.titles);
      const fresh = titles.filter(t => !prevSet.has(t));
      out.titles[src.key] = { label: src.label, track: src.track, total: titles.length, new: fresh };
      fs.writeFileSync(snapPath, JSON.stringify({ date: today, titles }, null, 2) + '\n');
      console.log(`${titles.length}건 · 신규 ${fresh.length}`);
    } catch (e) {
      out.failures.push({ key: src.key, kind: 'titles', error: String(e.message || e) });
      console.log(`실패 — ${e.message || e}`);
    }
  }

  fs.writeFileSync(path.join(FEED_DIR, `${today}.json`), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'feeds.md'), renderFeeds(out));
  console.log(`\nfeeds.md 생성 · 실패 ${out.failures.length}건`);
}

// 브리프가 읽는 요약. T2 슬롯 우선순위로 정렬한다.
function renderFeeds(out) {
  const order = ['T2-발견', 'T2-선점', 'T1', '신호'];
  let md = `# PLOT 피드 수집 — ${out.date}\n\n`;
  md += `> GitHub Actions가 수집. 브리프는 이 파일을 읽는다(RSS 직접 페치 불가 우회).\n`;
  md += `> 트랙 표기는 \`셀렉션-기준-정본.md\` 의 T1/T2 슬롯과 대응한다.\n\n`;

  if (out.failures.length) {
    md += `## ⚠️ 수집 실패 ${out.failures.length}건\n`;
    for (const f of out.failures) md += `- \`${f.key}\` (${f.kind}) — ${f.error}\n`;
    md += `\n`;
  }

  md += `## 국내 매체 신규 (제목 diff)\n`;
  const tk = Object.keys(out.titles);
  if (!tk.length) md += `_수집 없음_\n`;
  for (const k of tk) {
    const t = out.titles[k];
    md += `\n### ${t.label} · ${t.track} — 신규 ${t.new.length} / 전체 ${t.total}\n`;
    md += t.new.length ? t.new.map(x => `- ${x}`).join('\n') + '\n' : `_전일 대비 신규 없음_\n`;
  }

  md += `\n## RSS\n`;
  for (const track of order) {
    const keys = Object.keys(out.rss).filter(k => out.rss[k].track === track);
    if (!keys.length) continue;
    md += `\n### ${track}\n`;
    for (const k of keys) {
      const s = out.rss[k];
      md += `\n**${s.label}** (${s.count}건)\n`;
      if (!s.items.length) { md += `_최근 ${CFG._limits.rssMaxAgeDays}일 내 항목 없음_\n`; continue; }
      for (const i of s.items.slice(0, 12)) {
        md += `- ${i.published || '날짜없음'} · [${i.title}](${i.url})\n`;
        if (i.summary) md += `  · ${i.summary.slice(0, 180)}\n`;
      }
    }
  }
  return md;
}

// require 되면 함수만 노출(테스트용), 직접 실행되면 수집한다.
if (require.main === module) {
  main().catch(e => {
    // 전체가 죽는 건 설정 파일 문제뿐이어야 한다. 그래도 브리프를 막지는 않는다.
    console.error('collect.js 치명적 오류:', e);
    process.exit(0);
  });
}

module.exports = { parseFeed, extractTitles, stripTags, decodeEnt, unCDATA, linkOf, withinDays, renderFeeds };
