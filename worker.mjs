/**
 * ytm-worker —— YouTube Music 的 InnerTube 代理（Cloudflare Worker）
 *
 * 它就是 ytmusicapi 的 JS 版：直接调 music.youtube.com 的 /youtubei/v1/ 接口，
 * 把结果规整成页面需要的 {videoId,title,artist,duration,art}。
 * 部署一次，所有访客都能拿到实时数据，不需要装 Python、不需要跑本地桥。
 *
 * 接口（全部返回 JSON，带 CORS）：
 *   GET /health
 *   GET /songs?limit=8        随机一批歌（服务端洗牌袋，不重复）
 *   GET /search?q=…&limit=12  搜索歌曲
 *   GET /charts?limit=20      榜单歌曲
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler deploy            （在 ytm-worker/ 目录下）
 * 可选环境变量（wrangler.toml 或 wrangler secret）：
 *   YTM_TOKEN    设了就要求 ?token= 或 X-YTM-Token 头，防止别人白蹭你的额度
 *   YTM_LANG     默认 zh-CN
 *   YTM_REGION   默认 US
 *   YTM_KEY      覆盖 InnerTube 客户端 key（一般不用改）
 *
 * ⚠️ 这里的 key 是 YouTube Music 网页版自带的**公开客户端 key**，不是你的私密凭据，
 *    但它代表你的 Worker 在调用，公开部署建议配上 YTM_TOKEN。
 */

const YTM_DOMAIN = 'https://music.youtube.com';
const YTM_BASE = YTM_DOMAIN + '/youtubei/v1/';
const YTM_KEY_DEFAULT = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'; // WEB_REMIX 网页版公开 key
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0';
/* filter="songs" 的 protobuf params：EgWKAQ + II + AWoMEA4QChADEAQQCRAF */
const SONGS_PARAMS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const CHARTS_BROWSE_ID = 'FEmusic_charts';

const SEED_QUERIES = [
  '热门歌曲', '华语流行', 'Top Hits', 'Lo-Fi Beats',
  'Rock Classics', 'K-Pop', 'Jazz', 'EDM',
];

/* ---------------- InnerTube 客户端 ---------------- */
function clientVersion() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return '1.' + d + '.01.00';
}

async function innertube(endpoint, body, env) {
  const url = YTM_BASE + endpoint + '?alt=json&key=' + (env.YTM_KEY || YTM_KEY_DEFAULT) + '&prettyPrint=false';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      'origin': YTM_DOMAIN,
      accept: '*/*',
    },
    body: JSON.stringify(Object.assign({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: clientVersion(),
          hl: env.YTM_LANG || 'zh-CN',
          gl: env.YTM_REGION || 'US',
        },
        user: {},
      },
    }, body)),
  });
  if (!res.ok) throw new Error('InnerTube ' + endpoint + ' HTTP ' + res.status);
  return res.json();
}

/* ---------------- 通用解析 ----------------
   InnerTube 的返回是一棵深层嵌套的树，且字段位置随版本变化。
   这里不写死路径，而是整棵树里捞出所有 musicResponsiveListItemRenderer（歌曲行的通用容器），
   再按可用的字段提取 —— 比逐路径解析更耐改版。 */
function collectRenderers(node, out, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 24) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectRenderers(v, out, (depth || 0) + 1);
    return out;
  }
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  for (const k in node) {
    if (k === 'musicResponsiveListItemRenderer') continue;
    collectRenderers(node[k], out, (depth || 0) + 1);
  }
  return out;
}

function runsOf(col) {
  return (col && col.musicResponsiveListItemFlexColumnRenderer
    && col.musicResponsiveListItemFlexColumnRenderer.text
    && col.musicResponsiveListItemFlexColumnRenderer.text.runs) || [];
}

function findVideoId(r) {
  const cands = [
    r.playlistItemData && r.playlistItemData.videoId,
    r.navigationEndpoint && r.navigationEndpoint.watchEndpoint && r.navigationEndpoint.watchEndpoint.videoId,
    r.overlay && r.overlay.musicItemThumbnailOverlayRenderer
      && r.overlay.musicItemThumbnailOverlayRenderer.content
      && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
      && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
        .playNavigationEndpoint
      && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
        .playNavigationEndpoint.watchEndpoint
      && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
        .playNavigationEndpoint.watchEndpoint.videoId,
  ];
  const cols = r.flexColumns || [];
  for (const c of cols) {
    for (const run of runsOf(c)) {
      const v = run && run.navigationEndpoint && run.navigationEndpoint.watchEndpoint
        && run.navigationEndpoint.watchEndpoint.videoId;
      if (v) cands.push(v);
    }
  }
  for (const c of cands) if (c) return String(c);
  return '';
}

function findArt(r) {
  const t = r.thumbnail && r.thumbnail.musicThumbnailRenderer
    && r.thumbnail.musicThumbnailRenderer.thumbnail
    && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails;
  if (!Array.isArray(t) || !t.length) return '';
  /* 取一张宽度适中的：够清晰又不至于太大 */
  let best = t[0];
  for (const x of t) {
    if ((x.width || 0) >= 120 && (x.width || 0) <= 300) { best = x; break; }
    if ((x.width || 0) > (best.width || 0)) best = x;
  }
  return best.url || '';
}

const DUR_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const SEP_RE = /^[\s·•|/-]*$/;

function normalize(r) {
  const id = findVideoId(r);
  if (!id) return null;
  const cols = r.flexColumns || [];
  const c0 = runsOf(cols[0]).map((x) => (x && x.text) || '').filter(Boolean);
  const title = (c0[0] || '').trim() || ('歌曲 ' + id);
  /* 第二列通常是「艺人 • 专辑 • 时长」，按分隔符切 */
  const c1 = runsOf(cols[1]).map((x) => (x && x.text) || '');
  const parts = [];
  for (const t of c1) {
    const s = String(t).trim();
    if (!s || SEP_RE.test(s)) continue;
    if (!parts.includes(s)) parts.push(s);
  }
  let duration = '';
  const artists = [];
  const album = [];
  parts.forEach((p, i) => {
    if (DUR_RE.test(p)) { duration = p; return; }
    if (i === 0) artists.push(p); else album.push(p);
  });
  /* 兜底：时长可能藏在固定列里 */
  if (!duration) {
    for (const c of cols) {
      for (const run of runsOf(c)) {
        const s = String((run && run.text) || '').trim();
        if (DUR_RE.test(s)) { duration = s; break; }
      }
      if (duration) break;
    }
  }
  return {
    videoId: id,
    title,
    artist: artists.join(', ') || album.join(', '),
    duration,
    art: findArt(r),
  };
}

function songsFrom(json) {
  const out = [];
  const seen = {};
  for (const r of collectRenderers(json, [], 0)) {
    const s = normalize(r);
    if (!s || seen[s.videoId]) continue;
    seen[s.videoId] = 1;
    out.push(s);
  }
  return out;
}

/* ---------------- 候选池 + 洗牌袋 ---------------- */
let POOL = { at: 0, songs: [] };
let DECK = [];
let RECENT = [];
const POOL_TTL = 30 * 60 * 1000; /* 30 分钟 */

async function buildPool(env) {
  if (POOL.songs.length && Date.now() - POOL.at < POOL_TTL) return POOL.songs;
  const got = {};
  const add = (list) => {
    for (const s of list || []) if (!got[s.videoId]) got[s.videoId] = s;
  };
  /* 榜单 */
  try {
    add(songsFrom(await innertube('browse', { browseId: CHARTS_BROWSE_ID }, env)));
  } catch (e) { /* 忽略，继续用搜索补 */ }
  /* 搜索：并发跑几个种子词 */
  const results = await Promise.all(SEED_QUERIES.map((q) =>
    innertube('search', { query: q, params: SONGS_PARAMS }, env).catch(() => null)));
  for (const j of results) if (j) add(songsFrom(j));
  const songs = Object.keys(got).map((k) => got[k]);
  if (songs.length) POOL = { at: Date.now(), songs };
  return POOL.songs;
}

function draw(pool, limit) {
  if (!pool.length) return [];
  const out = [];
  let guard = 0;
  while (out.length < limit && guard++ < limit * 5 + 20) {
    if (!DECK.length) {
      const ban = {};
      const keep = Math.max(0, pool.length - limit);
      RECENT.slice(-keep).forEach((id) => { ban[id] = 1; });
      let fresh = pool.filter((s) => !ban[s.videoId]);
      if (fresh.length < limit) fresh = pool.slice();
      DECK = fresh.slice();
      /* Fisher–Yates */
      for (let i = DECK.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = DECK[i]; DECK[i] = DECK[j]; DECK[j] = t;
      }
    }
    const s = DECK.pop();
    if (s && !out.some((x) => x.videoId === s.videoId)) out.push(s);
  }
  out.forEach((s) => RECENT.push(s.videoId));
  RECENT = RECENT.slice(-200);
  return out;
}

/* ---------------- HTTP ---------------- */
function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  }, extra || {});
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: cors(extra) });
}

function authorized(req, url, env) {
  if (!env || !env.YTM_TOKEN) return true;
  const t = url.searchParams.get('token') || req.headers.get('X-YTM-Token') || '';
  return t === env.YTM_TOKEN;
}

/* 来源白名单：只有列出的站点能在浏览器里调用这个 Worker。
   令牌写在公开页面里等于公开，挡不住人；Origin/Referer 才是真正能拦住
   「别的网站直接嵌你的 Worker 蹭额度」的那道门。
   配法：YTM_ORIGINS = "https://user.github.io,http://127.0.0.1,http://localhost"
   （逗号分隔；留空 = 不限制，保持旧行为） */
function originAllowed(req, env) {
  const list = String((env && env.YTM_ORIGINS) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  if (list.includes('*')) return true;
  const o = req.headers.get('Origin') || '';
  const ref = req.headers.get('Referer') || '';
  /* 没有来源头（curl 之类）或 file:// 打开（Origin 为 "null"）：放行，方便本机调试 */
  if (!o && !ref) return true;
  if (o === 'null') return true;

  /* 按【主机名】比较，忽略端口 —— 这样条目写 http://localhost 就能覆盖
     http://localhost:8099；同时用完整主机名相等判断，避免
     "我的域名.evil.com" 这类前缀伪造绕过。 */
  let host = '', proto = '';
  try {
    const u = new URL(o || ref);
    host = (u.hostname || '').toLowerCase();
    proto = u.protocol;
  } catch (e) { return false; }
  for (const a of list) {
    let ah = '', ap = '';
    try {
      const u = new URL(a);
      ah = (u.hostname || '').toLowerCase();
      ap = u.protocol;
    } catch (e) { continue; }
    if (ah === host && (!ap || ap === proto)) return true;
  }
  return false;
}

export default {
  async fetch(req, env) {
    env = env || {};
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (!originAllowed(req, env)) return json({ error: 'origin not allowed' }, 403);
    if (!authorized(req, url, env)) return json({ error: 'unauthorized' }, 401);

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const limit = Math.max(1, Math.min(60, parseInt(url.searchParams.get('limit') || '8', 10) || 8));

    try {
      if (path === '/health' || path === '/') {
        return json({ ok: true, service: 'ytm-worker', client: 'WEB_REMIX', pool: POOL.songs.length });
      }
      if (path === '/songs') {
        let pool = await buildPool(env);
        if (!pool.length) pool = POOL.songs;
        if (!pool.length) return json({ error: 'InnerTube 没有返回可用歌曲' }, 502);
        return json({ songs: draw(pool, limit), source: 'ytmusicapi-innerTube' });
      }
      if (path === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ error: 'q is required' }, 400);
        const j = await innertube('search', { query: q, params: SONGS_PARAMS }, env);
        return json({ songs: songsFrom(j).slice(0, limit), source: 'ytmusicapi-innerTube' });
      }
      if (path === '/charts') {
        const j = await innertube('browse', { browseId: CHARTS_BROWSE_ID }, env);
        return json({ songs: songsFrom(j).slice(0, limit), source: 'ytmusicapi-innerTube' });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
