#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_ytm_bridge.py — YouTube Music 本地桥（供 pixel17.html 的 YouTube Music 应用取真实数据）

它把 ytmusicapi 包在几个只读的 HTTP 接口后面，并打开 CORS，
这样 file:// 打开的模拟器页面也能直接 fetch 到真实歌曲数据。

依赖：
    pip install ytmusicapi

运行：
    python _ytm_bridge.py                 # 默认监听 127.0.0.1:8722
    python _ytm_bridge.py --port 8800
    python _ytm_bridge.py --auth          # 首次需要「我的歌单/点赞」等个人数据时用

接口（全部 GET，返回 JSON，均带 CORS 头）：
    /health                        → {"ok":true,"ytmusicapi":"<版本>"}
    /songs?limit=8                 → 随机一批歌曲（真随机 + 不重复，见下）
    /search?q=关键词&limit=12       → 搜索歌曲
    /charts?limit=20               → 各地区榜单歌曲
    /playlist?id=PL...&limit=20     → 指定歌单的歌曲

返回的歌曲统一成：
    {"videoId":"...","title":"...","artist":"...","duration":"3:12","art":"https://..."}

设计要点：
  · 只用只读接口，不做任何写操作（收藏仍然存在模拟器本地的 localStorage 里）；
  · 服务端维护一个「洗牌袋」：把候选池洗好后一张张发，发完才重洗，
    并屏蔽最近发过的，因此「换一批」不会反复给同一批歌；
  · ytmusicapi 不可用/未登录时，/songs 会退化成 charts + 搜索的混合结果，
    仍然返回真实歌曲；连不上网络则返回 502，页面会自动回退到本地随机池。
"""

import argparse
import json
import random
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from ytmusicapi import YTMusic
    import ytmusicapi as _ytm_pkg
    YTM_VERSION = getattr(_ytm_pkg, "__version__", "unknown")
except Exception as exc:                                     # pragma: no cover
    sys.stderr.write(
        "[_ytm_bridge] 缺少 ytmusicapi，请先安装：\n"
        "    pip install ytmusicapi\n"
        "原始错误：%s\n" % exc
    )
    raise SystemExit(2)

# 一些稳定的公开歌单/榜单，作为歌曲候选来源
SEED_PLAYLISTS = [
    "PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj",   # 全球热门
    "PLw-VjHDlEOgvtnnnqWlTqByAtC7tXBg6D",
    "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
]
SEED_QUERIES = ["Top Hits", "Pop Hits", "Lo-Fi Beats", "Rock Classics", "K-Pop", "Jazz"]

_lock = threading.Lock()
_pool = []          # 候选歌曲池
_deck = []          # 洗牌袋：本轮还没发过的
_recent = []        # 最近发过的 videoId，重洗时用来屏蔽
RECENT_MAX = 60
POOL_MAX = 400


def _norm(track):
    """把 ytmusicapi 的返回条目统一成页面需要的结构。"""
    if not track:
        return None
    vid = track.get("videoId") or ""
    if not vid:
        return None
    artists = track.get("artists") or []
    if isinstance(artists, list):
        artist = ", ".join(a.get("name", "") for a in artists if isinstance(a, dict))
    else:
        artist = str(artists)
    thumbs = track.get("thumbnails") or []
    art = thumbs[-1].get("url", "") if thumbs else ""
    return {
        "videoId": vid,
        "title": (track.get("title") or "").strip(),
        "artist": artist.strip(),
        "duration": track.get("duration") or "",
        "art": art,
    }


def _fetch_pool(yt):
    """把候选池装满（歌单 + 榜单 + 若干搜索词），任何一步失败都跳过。"""
    global _pool
    got = {}

    def add(items):
        for it in items or []:
            s = _norm(it)
            if s and s["videoId"] not in got:
                got[s["videoId"]] = s

    for pid in SEED_PLAYLISTS:
        try:
            pl = yt.get_playlist(pid, limit=60)
            add(pl.get("tracks"))
        except Exception:
            pass
    for q in SEED_QUERIES:
        try:
            add(yt.search(q, filter="songs", limit=30))
        except Exception:
            pass
    try:
        for c in (yt.get_charts().get("countries") or {}).values():
            add(c.get("songs", {}).get("items") if isinstance(c.get("songs"), dict) else None)
    except Exception:
        pass

    if got:
        _pool = list(got.values())
        random.shuffle(_pool)
        sys.stderr.write("[_ytm_bridge] 候选池已就绪：%d 首\n" % len(_pool))
    return _pool


def draw(limit):
    """洗牌袋抽取：发完才重洗，重洗时屏蔽最近发过的，保证不反复给同一批。"""
    global _deck, _recent
    with _lock:
        if not _pool:
            return []
        out = []
        while len(out) < limit:
            if not _deck:
                ban = set(_recent[-min(len(_recent), max(0, len(_pool) - limit)):])
                fresh = [s for s in _pool if s["videoId"] not in ban]
                if len(fresh) < limit:
                    fresh = _pool[:]
                _deck = fresh[:]
                random.shuffle(_deck)
            item = _deck.pop()
            if item["videoId"] in [o["videoId"] for o in out]:
                continue
            out.append(item)
        for o in out:
            _recent.append(o["videoId"])
        _recent = _recent[-RECENT_MAX:]
        return out


class Handler(BaseHTTPRequestHandler):
    yt = None
    quiet = False

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write("[_ytm_bridge] %s\n" % (fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        # 关键：页面若部署在 https（如 GitHub Pages），浏览器会把它当「公网 → 本地」的
        # Private Network Access 请求。没有这个头，新版 Chrome 会直接拦掉预检。
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._json({}, 204)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        one = lambda k, d: (q.get(k) or [d])[0]
        try:
            if u.path == "/health":
                return self._json({"ok": True, "ytmusicapi": YTM_VERSION, "pool": len(_pool)})

            if u.path == "/songs":
                limit = max(1, min(40, int(one("limit", "8"))))
                songs = draw(limit)
                if not songs:
                    if not _fetch_pool(self.yt):
                        return self._json({"error": "no songs"}, 502)
                    songs = draw(limit)
                return self._json({"songs": songs, "source": "ytmusicapi"})

            if u.path == "/search":
                term = one("q", "").strip()
                limit = max(1, min(40, int(one("limit", "12"))))
                if not term:
                    return self._json({"error": "q is required"}, 400)
                raw = self.yt.search(term, filter="songs", limit=limit)
                return self._json({"songs": [s for s in map(_norm, raw) if s], "source": "ytmusicapi"})

            if u.path == "/charts":
                limit = max(1, min(60, int(one("limit", "20"))))
                songs = []
                try:
                    ch = self.yt.get_charts()
                    for c in (ch.get("countries") or {}).values():
                        songs.extend([s for s in map(_norm, (c.get("songs") or {}).get("items") or []) if s])
                        if len(songs) >= limit:
                            break
                except Exception:
                    pass
                return self._json({"songs": songs[:limit], "source": "ytmusicapi"})

            if u.path == "/playlist":
                pid = one("id", "").strip()
                limit = max(1, min(80, int(one("limit", "20"))))
                if not pid:
                    return self._json({"error": "id is required"}, 400)
                pl = self.yt.get_playlist(pid, limit=limit)
                return self._json({"songs": [s for s in map(_norm, pl.get("tracks")) if s], "source": "ytmusicapi"})

            return self._json({"error": "not found"}, 404)
        except Exception as exc:
            return self._json({"error": str(exc)}, 500)


def main():
    ap = argparse.ArgumentParser(description="YouTube Music local bridge for pixel17.html")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8722)
    ap.add_argument("--auth", action="store_true",
                    help="改用本机已保存的 oauth/browser 凭据（ytmusicapi 需要时）")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--dump", metavar="PATH",
                    help="导出歌曲快照到 JSON 后退出（不启服务）。"
                         "用于 GitHub Actions 在构建期固化数据，让静态站点也能有真实歌曲。")
    ap.add_argument("--dump-js", metavar="PATH",
                    help="同时导出一份 JS 版本（window.YTM_SNAPSHOT=…）。"
                         "用 <script src> 加载，file:// 下也能生效（fetch 本地文件会被浏览器拦掉）。")
    ap.add_argument("--limit", type=int, default=300, help="快照最多收录多少首（默认 300）")
    args = ap.parse_args()

    try:
        yt = YTMusic() if not args.auth else YTMusic("oauth.json")
    except Exception as exc:
        sys.stderr.write("[_ytm_bridge] 初始化 YTMusic 失败：%s\n" % exc)
        sys.stderr.write("[_ytm_bridge] 匿名模式仍可读取榜单与搜索，正在重试…\n")
        yt = YTMusic()

    # ---- 快照模式：取一批歌写成 JSON / JS，然后退出（供 CI 使用）----
    if args.dump or args.dump_js:
        pool = _fetch_pool(yt) or []
        if not pool:
            sys.stderr.write("[_ytm_bridge] 候选池为空，快照未生成\n")
            return 1
        take = pool[:] if args.limit >= len(pool) else random.sample(pool, args.limit)
        random.shuffle(take)
        snap = {
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "ytmusicapi",
            "ytmusicapi": YTM_VERSION,
            "count": len(take),
            "songs": take,
        }
        payload = json.dumps(snap, ensure_ascii=False, indent=1)
        if args.dump:
            with open(args.dump, "w", encoding="utf-8") as fh:
                fh.write(payload)
            sys.stderr.write("[_ytm_bridge] 已写出快照 %s：%d 首\n" % (args.dump, len(take)))
        if args.dump_js:
            with open(args.dump_js, "w", encoding="utf-8") as fh:
                fh.write("/* 由 _ytm_bridge.py --dump-js 生成，请勿手工编辑。\n"
                         "   用 <script src> 引入，file:// 下也能用（fetch 本地 JSON 会被浏览器拦掉）。 */\n")
                fh.write("window.YTM_SNAPSHOT=" + payload + ";\n")
            sys.stderr.write("[_ytm_bridge] 已写出 JS 快照 %s：%d 首\n" % (args.dump_js, len(take)))
        return 0

    Handler.yt = yt
    Handler.quiet = args.quiet
    threading.Thread(target=_fetch_pool, args=(yt,), daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write("[_ytm_bridge] 已启动：http://%s:%d  （把地址填进设置页或用 ?ytm= 覆盖）\n"
                     % (args.host, args.port))
    sys.stderr.write("[_ytm_bridge] 试一下：http://%s:%d/songs?limit=8\n" % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[_ytm_bridge] 已停止\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
