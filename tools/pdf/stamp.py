#!/usr/bin/env python3
"""stamp.py — PDF 각 페이지 하단에 문서명과 쪽번호를 찍는다.

왜 별도 단계인가:
  이 컨테이너의 wkhtmltopdf 는 unpatched qt 빌드라 --footer-* 옵션이 전부 무시된다.
  weasyprint 는 @page 로 번호를 넣을 수 있지만 이 환경에선 한글·숫자 글리프가 깨졌다.
  그래서 렌더는 wkhtmltopdf 에 맡기고, 번호만 reportlab 오버레이로 얹는다.

  python3 stamp.py <pdf> <문서명>
"""
import sys, io
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader, PdfWriter

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"


def main(path, label):
    # Noto CJK 는 CFF(postscript) 아웃라인이라 reportlab 이 못 읽는다.
    # 한글 TTF 가 있으면 쓰고, 없으면 라벨을 비우고 쪽번호만 찍는다.
    font = "Helvetica"
    for cand in ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
                 "/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf"):
        try:
            pdfmetrics.registerFont(TTFont("KR", cand))
            font = "KR"
            break
        except Exception:
            continue
    if font == "Helvetica" and any(ord(ch) > 0x2000 for ch in label):
        label = ""      # 깨진 네모를 찍느니 비운다

    reader = PdfReader(path)
    total = len(reader.pages)
    writer = PdfWriter()

    for i, page in enumerate(reader.pages, 1):
        w = float(page.mediabox.width)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(w, float(page.mediabox.height)))
        c.setFont(font, 7.5)
        c.setFillGray(0.62)
        c.drawString(42, 26, label)
        c.drawRightString(w - 42, 26, f"{i} / {total}")
        c.save()
        buf.seek(0)
        page.merge_page(PdfReader(buf).pages[0])
        writer.add_page(page)

    with open(path, "wb") as f:
        writer.write(f)
    print(f"쪽번호 {total}쪽 삽입")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
