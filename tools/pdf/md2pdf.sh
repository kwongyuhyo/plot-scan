#!/usr/bin/env bash
# md2pdf.sh — 브리프 마크다운을 PDF로 바꾼다.
#
#   ./md2pdf.sh 입력.md [출력.pdf]
#
# 왜 이 조합인가 (셋 다 실제로 돌려보고 고른 것):
#   · xelatex   — 한글은 되지만 이모지(🎧 ⚠️ ✅)에서 글리프가 깨진다. 브리프엔 이모지가 상시.
#   · weasyprint— @page 로 쪽번호가 되지만 이 컨테이너에선 한글·숫자 글리프가 통째로 깨졌다.
#   · wkhtmltopdf — 렌더가 가장 깨끗하다. 단 unpatched qt 빌드라 --footer-* 가 전부 무시된다.
#                   → 쪽번호는 stamp.py 로 따로 얹는다.
set -euo pipefail

SRC="$1"
OUT="${2:-${SRC%.md}.pdf}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CSS="$DIR/brief.css"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 쪽번호 옆에 찍을 문서명 — 첫 H1, 없으면 파일명.
TITLE="$(grep -m1 '^# ' "$SRC" | sed 's/^# *//' || true)"
[ -z "$TITLE" ] && TITLE="$(basename "${SRC%.md}")"

# title 은 비운다. 채우면 pandoc 이 본문 위에 제목 블록을 하나 더 그려서 H1 이 겹친다.
pandoc "$SRC" \
  --from=gfm --to=html5 --standalone \
  --metadata title="" \
  --css="$CSS" --embed-resources \
  -o "$TMP/brief.html"

wkhtmltopdf \
  --enable-local-file-access \
  --page-size A4 \
  --margin-top 16mm --margin-bottom 18mm \
  --margin-left 15mm --margin-right 15mm \
  --quiet \
  "$TMP/brief.html" "$OUT" 2>/dev/null

python3 "$DIR/stamp.py" "$OUT" "$TITLE" >/dev/null

echo "→ $OUT  ($(pdfinfo "$OUT" | awk '/^Pages/{print $2}')쪽)"
