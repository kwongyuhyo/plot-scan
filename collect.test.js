#!/usr/bin/env node
/**
 * collect.test.js — collect.js 파서 단위 테스트 (네트워크 없음)
 * 실행: node collect.test.js
 *
 * 여기 있는 케이스는 전부 실제로 겪은 버그에서 나왔다:
 *  · CDATA를 태그 제거보다 먼저 벗기지 않으면 제목이 통째로 사라진다
 *  · linkPattern에 캡처 그룹이 있으면 m[1]이 제목이 아니라 URL 조각을 가리킨다
 */
const m = require('./collect.js');
let fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fail++; };

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Big Blood: Trust the Music]]></title><link>https://daily.bandcamp.com/a</link>
<pubDate>Sat, 25 Jul 2026 10:00:00 +0000</pubDate>
<description><![CDATA[<p>Shoegaze guitars &amp; a lute.</p>]]></description></item>
<item><title>Old One</title><link>https://x/b</link><pubDate>Mon, 01 Jun 2026 10:00:00 +0000</pubDate></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Reddit post &#39;quoted&#39;</title><link href="https://reddit.com/x"/>
<updated>2026-07-26T01:00:00Z</updated><summary type="html">&lt;p&gt;body&lt;/p&gt;</summary></entry></feed>`;

const html = `<a href="/index.php?mid=news&document_srl=123">힙합엘이 신규 기사 제목입니다</a>
<a href="/index.php?mid=review&document_srl=124">리뷰 제목 두번째</a>
<a href="/about">짧음</a>
<a href="/index.php?mid=news&document_srl=123">힙합엘이 신규 기사 제목입니다</a>`;

const r = m.parseFeed(rss), a = m.parseFeed(atom);
const t = m.extractTitles(html, '/(index|kboard|news|review)[^"\']*');

ok('RSS 2건 파싱', r.length === 2);
ok('CDATA 제목 보존', r[0].title === 'Big Blood: Trust the Music');
ok('요약 태그제거+엔티티', r[0].summary === 'Shoegaze guitars & a lute.');
ok('pubDate → ISO', r[0].published === '2026-07-25');
ok('N일 필터', r.filter(i => m.withinDays(i, 3)).length === 1);
ok('Atom entry', a.length === 1 && a[0].published === '2026-07-26');
ok('Atom link href', a[0].url === 'https://reddit.com/x');
ok('숫자 엔티티', a[0].title === "Reddit post 'quoted'");
ok('제목추출·중복제거·길이필터', t.length === 2 && t[0].includes('힙합엘이'));
ok('renderFeeds 동작', m.renderFeeds({ date: '2026-07-26', rss: {}, titles: {}, failures: [] }).includes('2026-07-26'));

console.log(fail ? `\n${fail}건 실패` : '\n전부 통과');
process.exit(fail ? 1 : 0);
