---
name: wechat-published-history-cdp
description: >
  通过 Edge 浏览器 CDP 远程调试协议 + Playwright，直连微信公众号后台「发表记录」页，
  抓取「已发表文章目录」（标题 / 日期 / 阅读 / 赞 / 评论 / 分享），支持翻页拉全部、关键词筛选。
  适用于：未认证订阅号没有 API 时，快速盘点历史内容、为新文章找可链接的历史稿以提升用户粘性。
  触发场景：用户说"查一下已发表文章""拉历史发布目录""我发过哪些文章""查大纲相关历史稿""盘点公众号内容"时使用此 skill。
location: user
agent_created: true
---

# 微信公众号已发表文章目录查询（Edge CDP 方案）

## 概述

写新文章时经常需要**链接历史文章**来提升用户粘性，但公众号后台没有"导出全部已发表目录"的按钮，
人工翻页又慢又容易漏。本方案复用你**已登录的 Edge 后台会话**，通过 CDP 让 Playwright 接管浏览器，
直接打开「发表记录」页，把目录抓成一份干净的清单（含阅读/赞/评论/分享数据），可全文检索。

## 核心原理

```
用户 Edge（已登录 mp.weixin.qq.com，调试模式启动）
    ↓ connectOverCDP(127.0.0.1:9222)
Playwright 打开 发表记录页（appmsgpublish?sub=list，begin 翻页）
    ↓ 读 document.body.innerText（避开易崩的 screenshot）
解析成结构化目录 → 存 published_catalog.txt / .md
```

## ⚠️ 最关键的一个坑（踩了 5 轮才确认）

**「已发表内容」的真实入口是 `appmsgpublish?sub=list`，不是 `appmsg?type=2` / `type=10`！**

| URL | 实际页面 | 后果 |
|-----|---------|------|
| `appmsg?type=2` / `appmsg?type=10` | **图文素材库**（里面是 2017 年老素材，如"朝鲜导游常识""中朝边境一日游"） | 抓到的全是老垃圾，误以为"没发过" |
| `appmsgpublish?sub=list&begin=0&count=20` | **真正的已发表记录**（后台左侧「内容管理 → 发表记录」） | ✅ 正确 |

脚本里已写死正确 URL，直接用即可。**千万不要**改成 `appmsg?type=...`。

## 前置条件

1. Edge 以调试模式启动（见 `start_edge_cdp.ps1`），且**已登录**公众号后台（会话未过期；过期需扫码）
2. Node.js + `playwright-core` 可用（managed workspace 已预装）
3. 端口 `127.0.0.1:9222` 在监听

## 使用流程

### 第1步：确认 Edge CDP 已就绪

若 9222 未监听，先跑 `start_edge_cdp.ps1`（会重启 Edge 并保留登录态）。

### 第2步：运行查询脚本

```bash
# 拉全部已发表目录（翻页直到末页，上限 400 条）
NODE_PATH="C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules" \
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" \
query_published.js

# 只筛选含某关键词的历史稿（写新文章时找可链接的旧文）
NODE_PATH="C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules" \
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" \
query_published.js "大纲"

# 限定最多翻几页（调试用，默认 20 页）
query_published.js "" 2
```

- 输出文件：`published_catalog.txt`（纯文本清单）+ `published_catalog.md`（表格版，便于预览）
- 默认写到**脚本运行目录**；可用环境变量 `OUT_DIR` 覆盖输出位置
- 关键词筛选：`node query_published.js 大纲` → 只列出标题含"大纲"的文章

> 翻页说明：脚本按 `begin=0,20,40…` 翻页；若某页首篇与上页首篇重复（说明后台不支持 begin 翻页、走的是无限滚动），会自动停止，避免死循环。

## 拿到目录后怎么"链接历史文章"

微信编辑器插入链接**不需要原始 URL**：在正文选中文字 → 点「超链接」→ 选「从公众号历史文章选择」→ 按标题搜索即可。
所以这份目录里**精确的标题文本**就是你要搜的词。例如新文章想挂"大纲变化"相关旧文，先 `query_published.js 大纲`
拿到准确标题，再在编辑器里搜那个标题插入即可。

（若日后需要原始文章链接 `mp.weixin.qq.com/s?...`，可在脚本 `page.evaluate` 里额外抓取 `a[href*="/s?"]` 的 href，本 v1 未默认抓取。）

## 脚本模板（query_published.js）

```javascript
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OUT_DIR = process.env.OUT_DIR || process.cwd();
const FILTER = process.argv[2] || '';
const MAX_PAGES = parseInt(process.argv[3] || '20', 10);
const COUNT = 20;

const killer = setTimeout(() => process.exit(2), 180000);

function parseCatalog(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length);
  const arts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^(今天|昨天|星期|20\d{2}年)/.test(line)) continue;
    const date = line;
    let j = i + 1;
    if (j >= lines.length || lines[j] !== '已发表') continue;
    let k = j + 1;
    if (k >= lines.length) continue;
    let title = lines[k];
    let m = k + 1;
    if (title === '原创') { title = lines[m]; m = m + 1; }
    if (!title || /^\d+$/.test(title)) continue;
    const metrics = [];
    while (m < lines.length && /^\d+$/.test(lines[m])) { metrics.push(parseInt(lines[m], 10)); m++; }
    arts.push({ date, title, views: metrics[0] || 0, likes: metrics[1] || 0, comments: metrics[2] || 0, shares: metrics[3] || 0 });
    i = m - 1;
  }
  return arts;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages.find(p => p.url().includes('mp.weixin.qq.com')) || await context.newPage();
  let token = '';
  const mt = page.url().match(/token=(\d+)/);
  if (mt) token = mt[1];
  if (!token) { console.error('NO TOKEN - 请先在 Edge 打开 mp.weixin.qq.com 并登录'); clearTimeout(killer); process.exit(0); }

  const all = [];
  let begin = 0, pagesFetched = 0, lastFirstTitle = '';
  while (pagesFetched < MAX_PAGES) {
    const url = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=${begin}&count=${COUNT}&token=${token}&lang=zh_CN`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(12000);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const batch = parseCatalog(text);
    if (batch.length === 0) break;
    if (batch[0].title === lastFirstTitle) break; // 翻页去重
    lastFirstTitle = batch[0].title;
    all.push(...batch);
    pagesFetched++;
    if (batch.length < COUNT) break;
    begin += COUNT;
  }
  const shown = FILTER ? all.filter(a => a.title.includes(FILTER)) : all;
  const lines = shown.map((a, i) => `${i + 1}. [${a.date}] ${a.title}  (阅读 ${a.views} / 赞 ${a.likes} / 评论 ${a.comments} / 分享 ${a.shares})`);
  fs.writeFileSync(path.join(OUT_DIR, 'published_catalog.txt'), lines.join('\n') + '\n');
  console.log('TOTAL_FETCHED=' + all.length + (FILTER ? `  FILTER_MATCH=${shown.length}` : ''));
  console.log(lines.join('\n'));
  clearTimeout(killer);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); clearTimeout(killer); process.exit(1); });
```

## ⚠️ 关键踩坑备忘

### 1. 入口 URL 写错 = 抓到素材库
见顶部。这是最大的坑，`appmsg?type=2` 是素材库不是已发表。脚本已用正确 URL。

### 2. 必须等足 12 秒
微信后台是长轮询 + JS 异步渲染，`networkidle` 永不触发、`domcontentloaded` 后列表还是空骨架。
脚本固定 `sleep(12000)`（必要时可加到 15 秒），别急着读文本。

### 3. 别用 screenshot()
Playwright 的 `page.screenshot()` 在此 Windows + Edge CDP 环境下会导致 **Node 进程级崩溃**（try-catch 抓不到）。
一律改用 `page.evaluate(() => document.body.innerText)` 读文本来确认状态。

### 4. IPv6 问题
Node HTTP 客户端默认走 IPv6，连 `localhost:9222` 会失败。**始终用 `http://127.0.0.1:9222`**。

### 5. token 不写死
token 运行时从已登录页面的 `location.href` 动态提取，脚本不含任何凭据。

## 运行环境

| 依赖 | 路径 |
|------|------|
| Node.js | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe` |
| playwright-core | `C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules` |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |

## 相关文件

| 文件 | 用途 |
|------|------|
| `start_edge_cdp.ps1` | 以调试模式启动 Edge（含锁文件清理） |
| `query_published.js` | 连接 CDP → 打开发表记录 → 翻页抓取 → 解析成目录 |
| 输出 | `published_catalog.txt` / `published_catalog.md`（运行目录） |
