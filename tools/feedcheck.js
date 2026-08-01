#!/usr/bin/env node
/**
 * feedcheck.js — sources.json 의 피드가 실제로 살아있는지 확인한다.
 *
 * 왜 필요한가:
 *   수집소스-레지스트리의 원칙이 "재보지 않은 소스는 넣지 않는다" 인데,
 *   정작 **이미 넣은 소스가 언제 죽었는지** 알 방법이 없었다.
 *   feeds.md 의 실패 목록은 문서 맨 끝에 있어서 아무도 안 읽는다(4일 정지 사고).
 *   이건 손으로 아무 때나 돌려서 한 화면으로 보는 용도다.
 *
 * 실행:
 *   node tools/feedcheck.js              # 전체
 *   node tools/feedcheck.js starnews yt_  # key 앞부분으로 필터
 *
 * ⚠️ **클라우드 브리프 세션에서는 돌리지 마라.** 그쪽 이그레스 프록시가 외부 fetch를
 *    전부 403으로 막는다(2026-08-01 실측: Pitchfork·Reddit·YouTube 전부 403 — 실제로는
 *    Actions에서 잘 도는 소스들이다). 여기서 나온 403은 소스가 죽었다는 뜻이 아니다.
 *    → GitHub Actions 의 `feedcheck` 워크플로를 수동 실행해서 볼 것.
 *
 * 종료코드: 0 = 전부 살아있음 · 1 = 하나라도 죽음
 */
const path = require('path');
const { parseFeed, decodeBody } = require(path.join(__dirname, '..', 'collect.js'));
const CFG = require(path.join(__dirname, '..', 'sources.json'));

const UA = 'Mozilla/5.0 (compatible; plot-scan/1.0; +https://github.com/kwongyuhyo/plot-scan)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function check(src) {
  const t0 = Date.now();
  try {
    const res = await fetch(src.url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ...src, ok: false, why: `HTTP ${res.status}`, ms: Date.now() - t0 };

    const body = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
    const items = parseFeed(body);
    if (!items.length) return { ...src, ok: false, why: '항목 0건 — 피드가 아니거나 구조 변경', ms: Date.now() - t0 };

    // 한글이 깨졌는지 본다. 국내 매체인데 한글이 하나도 없으면 인코딩 사고다.
    const joined = items.slice(0, 5).map(i => i.title).join(' ');
    const hangul = /[가-힣]/.test(joined);
    const mojibake = /[�]/.test(joined);

    return {
      ...src, ok: !mojibake, ms: Date.now() - t0,
      why: mojibake ? '⚠️ 문자 깨짐(인코딩)' : '',
      count: items.length,
      latest: items.map(i => i.published).filter(Boolean).sort().pop() || '날짜없음',
      hangul, sample: (items[0]?.title || '').slice(0, 46),
    };
  } catch (e) {
    return { ...src, ok: false, why: String(e.message || e), ms: Date.now() - t0 };
  }
}

(async () => {
  const filters = process.argv.slice(2);
  const list = CFG.rss.filter(s => !filters.length || filters.some(f => s.key.startsWith(f)));
  if (!list.length) return console.log('해당하는 소스가 없다.');

  console.log(`\n피드 ${list.length}건 점검 — ${new Date().toISOString().slice(0, 16)}Z\n`);
  const rows = [];
  for (const s of list) {
    const r = await check(s);
    rows.push(r);
    const mark = r.ok ? '✅' : '❌';
    console.log(
      `${mark} ${r.key.padEnd(18)} ${String(r.count ?? '-').padStart(3)}건  ` +
      `${(r.latest || '-').padEnd(11)} ${String(r.ms).padStart(5)}ms  ${r.why || r.sample}`
    );
    await sleep(CFG._limits.fetchDelayMs || 1500);
  }

  const dead = rows.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(72)}\n살아있음 ${rows.length - dead.length} · 죽음 ${dead.length}`);
  if (dead.length) {
    console.log('\n죽은 소스 — sources.json 에서 빼거나 URL을 고쳐라:');
    for (const d of dead) console.log(`  · ${d.key} (${d.label}) — ${d.why}\n    ${d.url}`);
  }
  process.exit(dead.length ? 1 : 0);
})();
