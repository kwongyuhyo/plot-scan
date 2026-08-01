#!/usr/bin/env python3
"""
clipfind.py — 영상에서 숏폼으로 쓸 구간(분·초)을 뽑는다.

왜 필요한가:
  SENE 숏폼 봇은 `링크:` 에 로컬 영상 경로를 받는다. 그런데 어느 구간을 쓸지는
  사람이 영상을 처음부터 보며 골라야 했다. 이걸 후보 3~5개로 좁혀준다.

무엇을 근거로 고르나 (전부 실측 신호. 내용 이해가 아니다):
  1. 오디오 라우드니스   — 말·음악이 실제로 실린 구간
  2. 컷(씬 전환) 밀도    — 시각적으로 정보가 많은 구간
  3. 무음 비율          — 빈 구간 감점
  4. 컷 정렬            — 시작점이 컷 직후면 보너스 (깔끔하게 잘린다)

한계 (반드시 알고 쓸 것):
  · **내용을 이해하고 고르는 게 아니다.** "가장 신나는 곳"이지 "가장 중요한 곳"이 아니다.
  · 잔잔한 인터뷰의 핵심 발언처럼 **조용한데 중요한 구간은 못 잡는다.**
  · 최종 선택은 사람이 한다. 이건 훑는 시간을 줄이는 도구다.

실행:
  python3 clipfind.py <영상경로> [--len 30] [--top 5]

의존성: ffmpeg / ffprobe 만. 파이썬 패키지 없음.
"""

import subprocess, re, sys, json, argparse, shutil


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace")


def duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        sys.exit(f"길이를 못 읽었다. 영상 파일이 맞는지 확인: {path}")


def scene_cuts(path, thresh=0.3):
    """씬 전환 시각(초) 목록."""
    r = run(["ffmpeg", "-v", "info", "-i", path,
             "-vf", f"select='gt(scene,{thresh})',showinfo", "-f", "null", "-"])
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", r.stderr)]


def silences(path, noise="-30dB", d=0.5):
    """무음 구간 [(시작, 끝)] 목록."""
    r = run(["ffmpeg", "-v", "info", "-i", path,
             "-af", f"silencedetect=noise={noise}:d={d}", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.\-]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", r.stderr)]
    return list(zip(starts, ends + [10**9] * (len(starts) - len(ends))))


def loudness_buckets(path, dur, bucket=1.0):
    """초 단위 RMS 라우드니스(dB). astats 를 metadata 로 뽑아 파싱한다."""
    r = run(["ffmpeg", "-v", "info", "-i", path,
             "-af", f"astats=metadata=1:reset={bucket},"
                    f"ametadata=print:key=lavfi.astats.Overall.RMS_level",
             "-f", "null", "-"])
    vals, times = [], []
    cur_t = None
    for line in r.stderr.splitlines():
        m = re.search(r"pts_time:([0-9.]+)", line)
        if m:
            cur_t = float(m.group(1))
        m = re.search(r"RMS_level=(-?[0-9.]+|-inf)", line)
        if m and cur_t is not None:
            v = m.group(1)
            vals.append(-90.0 if v == "-inf" else float(v))
            times.append(cur_t)
    n = int(dur / bucket) + 1
    out = [-90.0] * n
    for t, v in zip(times, vals):
        i = int(t / bucket)
        if 0 <= i < n:
            out[i] = v
    return out


def mmss(t):
    return f"{int(t)//60}:{int(t)%60:02d}"


def analyze(path, clip_len, top):
    dur = duration(path)
    if dur < clip_len:
        sys.exit(f"영상이 {dur:.1f}초라 {clip_len}초 구간을 못 만든다.")

    cuts = scene_cuts(path)
    sil = silences(path)
    loud = loudness_buckets(path, dur)

    lo, hi = min(loud), max(loud)
    span = (hi - lo) or 1.0

    def silent_ratio(a, b):
        ov = sum(max(0, min(b, e) - max(a, s)) for s, e in sil)
        return min(1.0, ov / (b - a))

    step = 1.0
    cands = []
    t = 0.0
    while t + clip_len <= dur:
        a, b = t, t + clip_len
        seg = loud[int(a):int(b)] or [lo]
        l_norm = (sum(seg) / len(seg) - lo) / span            # 0~1
        c_in = [c for c in cuts if a <= c < b]
        c_norm = min(1.0, len(c_in) / max(1, clip_len / 5))   # 5초당 1컷이면 만점
        s_ratio = silent_ratio(a, b)
        aligned = any(abs(c - a) < 0.6 for c in cuts)

        score = l_norm * 0.5 + c_norm * 0.3 + (1 - s_ratio) * 0.2 + (0.05 if aligned else 0)
        cands.append({
            "start": a, "end": b, "score": round(score, 3),
            "loud": round(l_norm, 2), "cuts": len(c_in),
            "silent": round(s_ratio, 2), "aligned": aligned,
        })
        t += step

    cands.sort(key=lambda c: -c["score"])
    picked = []
    for c in cands:  # 겹치는 후보 제거
        if all(c["end"] <= p["start"] or c["start"] >= p["end"] for p in picked):
            picked.append(c)
        if len(picked) >= top:
            break

    return {"file": path, "duration": round(dur, 1), "clip_len": clip_len,
            "total_cuts": len(cuts), "candidates": picked}


def main():
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg 이 없다.")
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--len", type=int, default=30, help="구간 길이(초). 기본 30")
    ap.add_argument("--top", type=int, default=5, help="후보 개수. 기본 5")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    res = analyze(a.video, a.len, a.top)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return

    print(f"\n📹 {res['file']}  ·  전체 {mmss(res['duration'])}  ·  컷 {res['total_cuts']}개")
    print(f"   {res['clip_len']}초 구간 후보 {len(res['candidates'])}개\n")
    print(f"{'구간':<16}{'점수':<8}{'소리':<8}{'컷':<6}{'무음':<8}근거")
    print("─" * 74)
    for c in res["candidates"]:
        why = []
        if c["loud"] > 0.7: why.append("소리 큼")
        if c["cuts"] >= 2: why.append(f"컷 {c['cuts']}개")
        if c["silent"] < 0.1: why.append("빈틈 없음")
        if c["aligned"]: why.append("컷에서 시작")
        print(f"{mmss(c['start'])}–{mmss(c['end']):<10}{c['score']:<8}"
              f"{c['loud']:<8}{c['cuts']:<6}{c['silent']:<8}{' · '.join(why) or '—'}")
    print("\n※ 소리·컷 기준이라 '가장 신나는 곳'이지 '가장 중요한 곳'이 아니다.")
    print("  조용한데 중요한 구간(인터뷰 핵심 발언 등)은 못 잡는다. 최종 선택은 사람이.\n")


if __name__ == "__main__":
    main()
