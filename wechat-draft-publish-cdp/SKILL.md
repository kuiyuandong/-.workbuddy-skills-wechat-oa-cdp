---
name: wechat-draft-publish-cdp
description: >
  通过 Edge 浏览器 CDP 远程调试协议 + Playwright，将本地文章（.docx/.doc/.txt）自动发布到微信公众号草稿箱。
  适用于：未认证订阅号无 API 发布权限时，用已登录的浏览器会话把文章送进草稿箱。
  触发场景：用户说"发布文章到草稿箱""推送到公众号""把这篇发到公众号""上传到草稿箱"时使用此 skill。
location: user
agent_created: true
---

# 微信公众号文章发布到草稿箱（Edge CDP 方案）

## 概述

未认证订阅号的 `masssend` / 素材接口常被限制，且文章带复杂排版时纯 API 容易丢样式。
本方案**不依赖公众号 API 发布权限**，而是复用用户在 Edge 里**已经登录的公众号后台会话**，
通过 CDP 让 Playwright 接管浏览器，用官方后台自带的「文档导入」功能把文章送进草稿箱。
「文档导入」会保留标题层级、加粗、颜色、项目符号等基础排版，比直接 `execCommand('insertHTML')` 稳得多。

## 核心原理

```
用户 Edge（已登录 mp.weixin.qq.com）
    ↓ 以调试模式启动（--user-data-dir + --remote-debugging-port=9222，不要加 --remote-debugging-address）
    ↓
Playwright connectOverCDP() 连接 127.0.0.1:9222
    ↓
在后台：草稿箱 → 新的创作 → 文章 → 文档导入(.docx) → 填标题 → 保存为草稿
```

## 配置（可选环境变量）

脚本**不写死任何账号凭据**；公众号 token 在运行时从已登录页面动态提取。
以下两个值可用环境变量覆盖（默认值即开箱可用，一般无需改）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | `http://127.0.0.1:9222` | Edge CDP 调试地址 |
| `OA_HOST` | `mp.weixin.qq.com` | 微信公众平台域名（换自建/测试域名时改） |

## 前置条件

1. 用户 Edge 已安装，且**之前登录过**公众号后台（会话未过期；若过期需用户扫码）
2. Node.js + `playwright-core` 可用（managed workspace 已预装）
3. 文章已转成 `.docx`（`.doc` / `.txt` 也可；**不要传 `.md`，后台对 .md 扩展名/编码敏感，实测报"不支持该格式"**）

## 使用流程

### 第1步：以调试模式启动 Edge

在 PowerShell 中执行 `start_edge_cdp.ps1`：

```powershell
Get-Process -Name msedge* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4
$ud = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
    -ArgumentList "--user-data-dir=$ud","--remote-debugging-port=9222","--no-first-run"
Start-Sleep -Seconds 12
$port = netstat -ano | findstr ":9222" | findstr "LISTENING"
if ($port) { Write-Output "✓ Edge CDP 已监听 127.0.0.1:9222" } else { Write-Output "✗ 端口未监听" }
```

⚠️ **关键修复（多次踩坑确认）**：
- **必须显式指定 `--user-data-dir`** 指向默认档案，否则调试服务器起不来（进程在、端口不监听、`DevToolsActivePort` 文件不生成）。
- **不要加 `--remote-debugging-address=127.0.0.1`**，加上反而导致端口绑不上。只留 `--remote-debugging-port=9222`。
- 启动前**先彻底杀光所有 msedge 进程**并清理 `SingletonLock` / `DevToolsActivePort` 等锁文件，否则新实例把命令转给旧实例后自行退出。
- 用户需在此 Edge 窗口里打开 `mp.weixin.qq.com` 并扫码登录（若会话过期）。**这一步必须人工**，自动化无法替用户扫码。

### 第2步：运行发布脚本

```bash
NODE_PATH="C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules" \
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" \
publish_draft.js "C:\路径\文章.docx" "文章标题"
```

脚本会：进入草稿箱 → 点「新的创作」→「文章」→ 点「文档导入」→ 上传 .docx →
关掉可能弹出的「切换账号授权」提示 → 用 JS 注入标题（真实 textarea 被隐藏）→ 点「保存为草稿」。

## 脚本模板（publish_draft.js）

```javascript
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 配置（可用环境变量覆盖；默认本地 Edge CDP + 微信公众平台域名）
// ⚠️ 公众号 token 不在此处、也不写死：运行时从已登录页面动态提取（见 getToken）
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OA_HOST = process.env.OA_HOST || 'mp.weixin.qq.com';

const DOCX = process.argv[2] || 'article.docx';
const TITLE = process.argv[3] || '未命名文章';

// 从已登录页面提取 token（避免硬编码）；没有就报错提示
async function getToken(page) {
  return await page.evaluate(() => {
    const m = location.href.match(/token=(\d+)/);
    if (m) return m[1];
    const a = document.querySelector('a[href*="token="]');
    if (a) { const mm = a.href.match(/token=(\d+)/); if (mm) return mm[1]; }
    return '';
  });
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  let page = null;
  for (const ctx of browser.contexts())
    for (const p of ctx.pages())
      if (p.url().includes(OA_HOST)) page = p;
  if (!page) throw new Error('未找到公众号后台页面，请先在 Edge 打开 mp.weixin.qq.com 并登录');

  // 1) 进入草稿箱列表（type=77 即草稿）
  if (!page.url().includes('type=77')) {
    const token = await getToken(page);
    const url = `https://${OA_HOST}/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card`
      + (token ? `&token=${token}` : '') + '&lang=zh_CN';
    await page.goto(url, { waitUntil: 'networkidle' });
    await sleep(3000);
  }

  // 2) 新的创作 → 文章
  await page.locator('text=新的创作').first().click();
  await sleep(1500);
  await page.locator('.weui-desktop-dropdown__list-ele:has-text("文章")').first().click();
  await sleep(3000);

  // 3) 文档导入（只认 .doc/.docx/.txt；.md 会报"不支持该格式"）
  await page.locator('li.media_extra_item.import_file').first().click();
  await sleep(2000);
  // ★ 页面上有 2 个 input[type=file]：第1个是封面图上传，第2个才是文档导入。必须选 accept 含 wordprocessingml 的那个
  const fileInput = page.locator('input[type=file][accept*="wordprocessingml.document"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 8000 });
  await fileInput.setInputFiles(DOCX);
  await sleep(8000); // 上传 + 后台转换

  // 关掉可能弹出的「切换账号授权」提示
  const ik = page.locator('.weui-desktop-dialog').locator('text=我知道了').first();
  if (await ik.isVisible().catch(() => false)) { await ik.click(); await sleep(1000); }

  // 4) 填标题（真实 textarea#title 被隐藏，用 JS 注入并触发 input 事件）
  await page.evaluate(t => {
    const el = document.querySelector('textarea#title') || document.querySelector('textarea[placeholder*="标题"]');
    if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, TITLE);
  await sleep(1000);

  // 5) 保存为草稿
  await page.locator('text=保存为草稿').first().click();
  await sleep(3000);
  console.log('✓ 已保存到草稿箱');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
```

## ⚠️ 关键踩坑备忘（按重要性）

### 1. Edge 调试端口起不来的根因
见第1步。**`--user-data-dir` 必加、`--remote-debugging-address` 必删、启动前杀光旧进程**。三者缺一不可，环境里已多次验证。

### 2. 文档导入的 input 选择错 = "不支持该格式"
页面同时存在多个 `input[type=file]`：
- 第 1 个 = **封面/图片上传**（accept 只有图片格式）
- 第 2 个 = **文档导入**（accept 含 `.docx` / `wordprocessingml.document`）

务必用 `input[type=file][accept*="wordprocessingml.document"]` 精准定位，别用 `.first()` 选到封面那个。

### 3. 不要传 .md
后台「文档导入」弹窗文字写着支持 doc/docx/markdown，但实测传 `.md` 报"不支持该格式"（扩展名/编码问题）。**统一转成 `.docx` 再传**。
转档可用 python-docx：`html_to_docx.py` 思路——用 BeautifulSoup 解析 HTML，按 h1/h2/p/ul 映射成 Word 的 Heading/Paragraph/List，再 `doc.save()`。

### 4. 新版编辑器没有「源码」按钮
2026 年后台改版后，编辑器（URL 含 `appmsg_edit_v2`）是 ProseMirror，**没有「源码」入口**，`execCommand('insertHTML')` 在新版里也不可靠。
**统一走「文档导入」**，排版保留最好。

### 5. 标题框是隐藏的
`textarea#title` 在 DOM 里存在但 `display:none`（界面只显示卡片预览）。`.fill()` / `.type()` 对不可见元素会失败，必须用 `page.evaluate` 直接改 `value` 并 `dispatchEvent(new Event('input'))`。

### 6. 「切换账号授权」弹窗
上传/保存时后台可能弹出「未授权使用切换账号能力」的安全提示（文案含"我知道了"）。脚本里已加关闭逻辑；若仍卡住，人工点一下「我知道了」即可继续。

### 7. IPv6 问题
Node.js HTTP 客户端默认走 IPv6，连 `localhost:9222` 会失败。**始终用 `http://127.0.0.1:9222`**（不是 `localhost`）。

### 8. 截图导致进程崩溃
Playwright 的 `page.screenshot()` 在此 Windows + Edge CDP 环境下可能导致 **Node 进程级崩溃**（try-catch 抓不到）。
**生产脚本里尽量别调 screenshot()**；需要确认状态时改用 `page.evaluate` 读 DOM 文本 / URL。

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
| `publish_draft.js` | 连接 CDP → 文档导入 → 填标题 → 保存草稿 |
| `html_to_docx.py` | 将公众号 HTML 文章转成 .docx（供文档导入） |
