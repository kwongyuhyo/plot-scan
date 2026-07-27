#!/usr/bin/env node
/**
 * promote.js — 워치리스트 3분할 관리 + 발굴 풀 자동 승격
 *
 * 왜 필요한가:
 *   2026-07-26 실측 — 성시경 '희재'가 171위로 +19 급등했는데 워치리스트가 못 잡았다.
 *   밀도는 오르는데 정작 가장 빨리 오르는 곡이 리스트 밖에 있는 구조 = 갱신 규칙 부재.
 *
 * 3분할 (수집소스-레지스트리 §7-5):
 *   watchlist.json            코어 108명 — 밀도 지표의 분모. **고정. 이 스크립트는 절대 건드리지 않는다.**
 *                             (늘리면 밀도가 자동 상승해 시계열이 끊긴다)
 *   watchlist-coverage.json   커버리지 — T1 누락 방지용. 밀도 계산에 넣지 않는다. 사람이 관리
 *   watchlist-discovery.json  발굴 풀 — 이 스크립트가 자동으로 채운다. T2 후보 관찰용
 *
 * 승격 규칙:
 *   오늘 차트에서 (+SURGE_MIN 이상 급등) 또는 (NEW이면서 NEW_MAX_POS 이내) 인데
 *   세 리스트 어디에도 없는 아티스트 → 발굴 풀에 추가.
 *   이미 있으면 lastSeen·bestRank·hits 갱신.
 *   STALE_DAYS 넘게 안 보이면 dormant 표시(삭제는 하지 않는다 — 판단은 사람이).
 *
 * 실행: node promote.js
 * 의존성 0.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

const SURGE_MIN = 15;      // scan.js와 동일 기준
const NEW_MAX_POS = 100;
const STALE_DAYS = 60;

const CORE = path.join(ROOT, 'watchlist.json');
const COVERAGE = path.join(ROOT, 'watchlist-coverage.json');
const DISCOVERY = path.join(ROOT, 'watchlist-discovery.json');

function dateStr(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function fromCSV(text) {
  return text.trim().split('\n').slice(1).map(line => {
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
      artistIds: cells[7] ? cells[7].split(';') : [],
    };
  }).filter(e => Number.isFinite(e.pos));
}

// "CORTIS - REDRED" → "CORTIS"  ·  피처링·콜라보는 첫 아티스트 기준
function artistOf(title) {
  const a = String(title).split(' - ')[0] || '';
  return a.split(/\s*[,&]\s*|\s+(?:feat\.?|with|x|X)\s+/)[0].trim();
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

function changeNum(change) {
  const n = parseInt(String(change).replace(/[^\-\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function main() {
  const today = dateStr();

  const core = readJSON(CORE, []);
  const coverage = readJSON(COVERAGE, { _comment: '', artists: [] });
  const discovery = readJSON(DISCOVERY, { _comment: '', artists: [] });

  // 세 리스트를 하나의 매칭 인덱스로
  const known = new Set();
  const addKnown = o => {
    for (const k of [o.name, o.eng]) if (k) known.add(norm(k));
  };
  core.forEach(addKnown);
  (coverage.artists || []).forEach(addKnown);
  (discovery.artists || []).forEach(addKnown);

  const knownIds = new Set(core.map(w => w.spotifyId).filter(Boolean));

  // 오늘 차트 읽기 (스포티파이 우선, 없으면 유튜브)
  const candidates = [];
  for (const src of ['spotify', 'youtube']) {
    const p = path.join(DATA, `${src}_${today}.csv`);
    if (!fs.existsSync(p)) { console.log(`[${src}] ${today} CSV 없음 — 건너뜀`); continue; }
    const rows = fromCSV(fs.readFileSync(p, 'utf8'));
    for (const e of rows) {
      const n = changeNum(e.change);
      const isSurge = n != null && n >= SURGE_MIN;
      const isNew = /new/i.test(String(e.change)) && e.pos <= NEW_MAX_POS;
      if (!isSurge && !isNew) continue;
      candidates.push({ ...e, src, reason: isSurge ? `+${n}` : 'NEW' });
    }
  }

  const byName = new Map();
  for (const c of candidates) {
    const name = artistOf(c.title);
    if (!name) continue;
    const key = norm(name);
    const prev = byName.get(key);
    if (!prev || c.pos < prev.pos) byName.set(key, { ...c, name });
  }

  // 승격
  const idx = new Map((discovery.artists || []).map(a => [norm(a.name), a]));
  let added = 0, updated = 0;

  for (const [key, c] of byName) {
    const inCore = known.has(key) || c.artistIds.some(id => knownIds.has(id));
    if (inCore && !idx.has(key)) continue; // 이미 코어/커버리지에 있으면 발굴 풀에 넣지 않는다

    const existing = idx.get(key);
    if (existing) {
      existing.lastSeen = today;
      existing.hits = (existing.hits || 0) + 1;
      existing.bestRank = Math.min(existing.bestRank ?? 999, c.pos);
      delete existing.dormant;
      updated++;
    } else if (!inCore) {
      const a = {
        name: c.name,
        eng: '',
        spotifyId: c.artistIds[0] || '',
        firstSeen: today,
        lastSeen: today,
        bestRank: c.pos,
        hits: 1,
        note: `자동 승격 — ${c.src} ${c.pos}위 ${c.reason}`,
      };
      discovery.artists.push(a);
      idx.set(key, a);
      added++;
    }
  }

  // 오래 안 보인 항목 표시 (삭제하지 않는다)
  for (const a of discovery.artists) {
    const age = (new Date(today) - new Date(a.lastSeen || a.firstSeen)) / 86400000;
    if (age > STALE_DAYS) a.dormant = true;
  }

  discovery._comment =
    '발굴 풀 — promote.js가 자동 관리. 차트에서 급등/신규 진입했는데 코어·커버리지 어디에도 없는 아티스트. ' +
    '밀도 지표 계산에는 절대 넣지 않는다. 관찰하다 확실해지면 사람이 watchlist-coverage.json으로 옮긴다.';
  discovery.updated = today;
  discovery.count = discovery.artists.length;

  fs.writeFileSync(DISCOVERY, JSON.stringify(discovery, null, 2) + '\n');

  console.log(
    `promote: 후보 ${byName.size}명 · 신규 승격 ${added} · 갱신 ${updated} · ` +
    `발굴 풀 총 ${discovery.artists.length} (dormant ${discovery.artists.filter(a => a.dormant).length})`
  );
  if (added) console.log('  신규:', discovery.artists.slice(-added).map(a => a.name).join(', '));

  // 코어는 절대 건드리지 않았음을 보증
  const coreNow = readJSON(CORE, []);
  if (coreNow.length !== core.length) {
    console.error('!! 코어 워치리스트가 변경됨 — 있을 수 없는 일. 확인 필요.');
    process.exit(1);
  }
}

main();
