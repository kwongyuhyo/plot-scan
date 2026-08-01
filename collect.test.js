#!/usr/bin/env node
/**
 * collect.test.js — collect.js 파서 단위 테스트 (네트워크 없음)
 * 실행: node collect.test.js
 *
 * 여기 있는 케이스는 전부 실제로 겪은 버그에서 나왔다:
 *  · CDATA를 태그 제거보다 먼저 벗기지 않으면 제목이 통째로 사라진다
 *  · linkPattern에 캡처 그룹이 있으면 m[1]이 제목이 아니라 URL 조각을 가리킨다
 *  · 국내 매체 RSS가 EUC-KR인데 UTF-8로 읽으면 파싱은 성공하고 내용만 깨진다(조용한 오염)
 */
const m = require('./collect.js');
let fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fail++; };

// ⚠️ 날짜는 **절대 하드코딩하지 마라.**
// 2026-07-25 고정 픽스처가 rssMaxAgeDays=3 필터 테스트에 쓰였다가 07-29에 4일이 되면서
// 실패했고, 이 파일이 워크플로의 fatal 단계라 파이프라인 전체가 4일간 정지했다.
// 시간이 지나면 깨지는 테스트는 테스트가 아니라 시한폭탄이다. 항상 now 기준 상대값으로 만든다.
const DAY = 86400000;
const ago = n => new Date(Date.now() - n * DAY);
const rfc = d => d.toUTCString();
const iso = d => d.toISOString().slice(0, 10);

const FRESH = ago(1);     // 필터 통과해야 하는 항목
const STALE = ago(60);    // 필터에 걸러져야 하는 항목

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Big Blood: Trust the Music]]></title><link>https://daily.bandcamp.com/a</link>
<pubDate>${rfc(FRESH)}</pubDate>
<description><![CDATA[<p>Shoegaze guitars &amp; a lute.</p>]]></description></item>
<item><title>Old One</title><link>https://x/b</link><pubDate>${rfc(STALE)}</pubDate></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Reddit post &#39;quoted&#39;</title><link href="https://reddit.com/x"/>
<updated>${FRESH.toISOString()}</updated><summary type="html">&lt;p&gt;body&lt;/p&gt;</summary></entry></feed>`;

const html = `<a href="/index.php?mid=news&document_srl=123">힙합엘이 신규 기사 제목입니다</a>
<a href="/index.php?mid=review&document_srl=124">리뷰 제목 두번째</a>
<a href="/about">짧음</a>
<a href="/index.php?mid=news&document_srl=123">힙합엘이 신규 기사 제목입니다</a>`;

const r = m.parseFeed(rss), a = m.parseFeed(atom);
const t = m.extractTitles(html, '/(index|kboard|news|review)[^"\']*');

ok('RSS 2건 파싱', r.length === 2);
ok('CDATA 제목 보존', r[0].title === 'Big Blood: Trust the Music');
ok('요약 태그제거+엔티티', r[0].summary === 'Shoegaze guitars & a lute.');
ok('pubDate → ISO', r[0].published === iso(FRESH));
ok('N일 필터', r.filter(i => m.withinDays(i, 3)).length === 1);
ok('Atom entry', a.length === 1 && a[0].published === iso(FRESH));
ok('Atom link href', a[0].url === 'https://reddit.com/x');
ok('숫자 엔티티', a[0].title === "Reddit post 'quoted'");
ok('제목추출·중복제거·길이필터', t.length === 2 && t[0].includes('힙합엘이'));
ok('renderFeeds 동작', m.renderFeeds({ date: '2026-07-26', rss: {}, titles: {}, failures: [] }).includes('2026-07-26'));

// ── 인코딩 ────────────────────────────────────────────────
// EUC-KR '한국어 제목' — 헤더에 charset이 없고 XML 선언에만 있는 경우가 국내 매체의 기본값이다.
const euckrBody = Buffer.concat([
  Buffer.from(`<?xml version="1.0" encoding="EUC-KR"?><rss><channel><item><title>`, 'latin1'),
  Buffer.from([0xC7, 0xD1, 0xB1, 0xB9, 0xBE, 0xEE]),          // '한국어'
  Buffer.from(`</title></item></channel></rss>`, 'latin1'),
]);
ok('EUC-KR · XML 선언에서 charset 검출', m.decodeBody(euckrBody, null).includes('한국어'));
ok('EUC-KR · 헤더 charset 우선', m.decodeBody(euckrBody, 'text/xml; charset=EUC-KR').includes('한국어'));
ok('UTF-8 기본값 유지', m.decodeBody(Buffer.from('<t>한국어</t>', 'utf8'), null).includes('한국어'));
ok('ks_c_5601-1987 별칭', m.normCharset('ks_c_5601-1987') === 'euc-kr');
ok('cp949 별칭', m.normCharset('CP949') === 'euc-kr');
ok('알 수 없는 인코딩 → 죽지 않음', typeof m.decodeBody(Buffer.from('abc'), 'text/xml; charset=bogus-9') === 'string');
ok('신호-현장 트랙 렌더', m.renderFeeds({
  date: '2026-08-01', titles: {}, failures: [],
  rss: { yt_x: { label: '워터밤 공식', track: '신호-현장', count: 1,
                 items: [{ title: 'BIBI - BUMPA Live', url: 'https://y/1', published: '2026-08-01' }] } },
}).includes('신호-현장'));

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
