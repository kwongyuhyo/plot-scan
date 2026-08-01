#!/usr/bin/env python3
"""
fitcheck.py — PLOT 카드뉴스 초안이 봇 렌더 한계를 넘는지 검사한다.

왜 필요한가:
  PLOT 카드뉴스는 글자수로 자르지 않고 ①폰트 축소 → ②줄바꿈 → ③말줄임 순으로 맞춘다.
  그래서 "안 잘렸다"고 안전한 게 아니다. 디자인 상한을 넘으면 폰트가 쪼그라들어
  시안 비율이 무너진다. 가장 자주 터지는 곳이 **릴리즈형 커버 제목(11자)** 이다.
  SENE 기준 25자를 그대로 넣으면 84px가 40px까지 내려간다.

수치 근거: bot/generators/card_news.py 실코드 + GothicA1-ExtraBold 폰트 실측 (2026-07-27)

실행:
  python3 fitcheck.py <초안파일>
  cat 초안 | python3 fitcheck.py -

종료코드: 0 = 통과 · 1 = 디자인 상한 초과 있음
"""

import sys, re

# (디자인 상한, 물리 상한) — 한글 기준, 공백 제외
LIMITS = {
    "커버제목_뉴스":     (22, 22, "84px 최대 2줄. **폰트 축소 없음** — 넘으면 바로 말줄임"),
    "커버제목_릴리즈":   (11, 24, "84→40px 1줄. 아티스트명 칸. 넘으면 커버 비율 붕괴"),
    "커버제목2_릴리즈":  (18, 34, "52→28px 1줄. 앨범명 칸"),
    "커버부제":          (33, 54, "29→18px 1줄"),
    "슬라이드소제목":    (21, 36, "48→28px 1줄"),
    "본문":             (180, 180, "28px 고정 최대 5줄. **폰트 축소 없음**"),
    "중간항목_신보":     (27, 40, "36→24px 1줄. 최대 4항목"),
}

# 초안 생성 시 권장값 — 디자인 상한에서 1~2자 뺀 것. 조사·띄어쓰기 변주를 흡수한다.
RECOMMEND = {
    "커버제목_뉴스": 20, "커버제목_릴리즈": 10, "커버제목2_릴리즈": 16,
    "커버부제": 30, "슬라이드소제목": 20, "본문": 160, "중간항목_신보": 25,
}

RELEASE_CATS = {"new release!", "new release", "오늘의 노래"}


def klen(s):
    """한글 기준 길이. 공백은 세지 않는다(스펙이 공백 제외 기준)."""
    return len(re.sub(r"\s", "", s))


def body_lines(text):
    """본문 줄 예산 계산. 빈 줄도 1줄을 먹는다(card_news.py:422)."""
    paras = text.split("\n")
    used = 0
    for i, p in enumerate(paras):
        used += max(1, (klen(p) + 35) // 36)   # 36자/줄
        if i < len(paras) - 1 and p.strip() == "":
            pass  # 빈 줄 자체가 위에서 1로 계산됨
    return used


FIELD_RE = re.compile(r"^(소스|구간|제목2?|부제|소제목|본문|출처)\s*:\s*(.*)$")


def parse(text):
    """[카테고리]/[커버]/[슬라이드] 블록을 뜯는다.

    본문은 여러 줄에 걸칠 수 있다. 다음 `필드:` 나 `[블록]` 이 나올 때까지 이어 붙인다.
    이게 없으면 정작 검사해야 할 **문단 개행 함정**을 못 잡는다.
    """
    cards, cur, block = [], None, None
    pending = None          # (dict, 필드명) — 여러 줄 이어받는 중인 필드

    def flush():
        nonlocal pending
        if pending:
            d, k = pending
            d[k] = d[k].rstrip("\n")
            pending = None

    for line in text.splitlines():
        s = line.strip()

        m = re.match(r"^\[(카테고리|캡션|커버|슬라이드|영상|메인|곡\d+)\]$", s)
        if m:
            flush()
            block = m.group(1)
            if block == "카테고리":
                cur = {"category": "", "cover": {}, "slides": []}
                cards.append(cur)
            elif block == "슬라이드" and cur is not None:
                cur["slides"].append({})
            continue

        if cur is None:
            continue

        if block == "카테고리":
            if s and not s.startswith("("):
                cur["category"] = s
            continue

        if block in ("커버", "슬라이드"):
            fm = FIELD_RE.match(s)
            if fm:
                flush()
                target = cur["cover"] if block == "커버" else cur["slides"][-1]
                key, val = fm.group(1), fm.group(2)
                target[key] = val
                if key == "본문":            # 본문만 여러 줄을 이어받는다
                    pending = (target, key)
            elif pending:
                d, k = pending
                d[k] += "\n" + line.rstrip()   # 빈 줄도 그대로 — 줄 예산 계산에 필요
    flush()
    return cards


def check(text):
    cards = parse(text)
    if not cards:
        print("❌ [카테고리] 블록을 못 찾았다. PLOT 카드뉴스 양식이 맞는지 확인.")
        return 1

    fails = warns = 0
    for i, c in enumerate(cards, 1):
        cat = c["category"].strip()
        is_release = cat.lower() in RELEASE_CATS
        kind = "릴리즈형" if is_release else "뉴스형"
        print(f"\n━━ 카드뉴스 {i} · 카테고리 `{cat or '(비어있음)'}` · {kind} "
              f"· 슬라이드 {len(c['slides'])}장")

        def judge(label, key, val):
            nonlocal fails, warns
            if not val:
                return
            n = klen(val)
            design, phys, note = LIMITS[key]
            rec = RECOMMEND[key]
            if n > phys:
                print(f"  ❌ {label}: {n}자 — 물리 상한 {phys} 초과. **잘린다**")
                print(f"     {note}")
                fails += 1
            elif n > design:
                print(f"  ❌ {label}: {n}자 — 디자인 상한 {design} 초과. **폰트가 쪼그라든다**")
                print(f"     {note}")
                fails += 1
            elif n > rec:
                print(f"  ⚠️  {label}: {n}자 — 권장 {rec} 초과 (상한 {design}). 여유가 없다")
                warns += 1
            else:
                print(f"  ✅ {label}: {n}자 (권장 {rec})")

        cov = c["cover"]
        if is_release:
            judge("커버 제목(아티스트)", "커버제목_릴리즈", cov.get("제목", ""))
            judge("커버 제목2(앨범)", "커버제목2_릴리즈", cov.get("제목2", ""))
            if not cov.get("제목2"):
                judge("커버 부제", "커버제목2_릴리즈", cov.get("부제", ""))
        else:
            judge("커버 제목", "커버제목_뉴스", cov.get("제목", ""))
            judge("커버 부제", "커버부제", cov.get("부제", ""))

        for j, sl in enumerate(c["slides"], 1):
            judge(f"슬라이드{j} 소제목", "슬라이드소제목", sl.get("소제목", ""))
            body = sl.get("본문", "")
            if body:
                n, lines = klen(body), body_lines(body)
                if lines > 5:
                    print(f"  ❌ 슬라이드{j} 본문: {n}자 · {lines}줄 — **5줄 초과. 잘린다**")
                    print(f"     문단 개행이 줄을 먹는다. 개행 없이 한 덩어리로 쓰면 해결")
                    fails += 1
                elif n > RECOMMEND["본문"]:
                    print(f"  ⚠️  슬라이드{j} 본문: {n}자 · {lines}/5줄 — 권장 160 초과")
                    warns += 1
                else:
                    print(f"  ✅ 슬라이드{j} 본문: {n}자 · {lines}/5줄")
            if not sl.get("소스"):
                print(f"  ⚠️  슬라이드{j}: `소스:` 가 비었다 — PLOT은 **검색어가 아니라 URL**이 필요하다")
                warns += 1
            if sl.get("구간") and not re.match(r"^\d+:\d{2}-\d+:\d{2}$", sl["구간"].strip()):
                print(f"  ❌ 슬라이드{j} 구간 `{sl['구간']}` — 형식은 `M:SS-M:SS`, 구분자는 하이픈")
                fails += 1

    print(f"\n{'─'*60}")
    print(f"오류 {fails} · 경고 {warns}")
    if fails:
        print("→ 오류를 고치기 전에는 봇에 넣지 마라. 디자인이 깨진다.")
    return 1 if fails else 0


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    sys.exit(check(text))
