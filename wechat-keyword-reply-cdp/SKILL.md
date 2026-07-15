---
name: wechat-keyword-reply-cdp
description: >
  通过 Edge 浏览器 CDP 远程调试协议 + Playwright，在公众号后台配置「关键词自动回复」。
  适用于：未认证订阅号无 API 写权限时，用已登录的浏览器会话批量配置关键词规则。
  触发场景：用户说"配关键词自动回复""加个关键词""回复【xx】发xx""设置关键词"时使用此 skill。
location: user
agent_created: true
---

# 微信公众号关键词自动回复配置（Edge CDP 方案）

## 概述

未认证订阅号部分自动回复 API 受限，本方案**复用用户在 Edge 里已登录的公众号后台会话**，
通过 CDP 让 Playwright 接管浏览器，在「互动管理 → 自动回复 → 关键词回复」里配置规则。
支持：文本回复、图文消息回复（选已发布文章）、半匹配/全匹配。

## 核心原理

```
用户 Edge（已登录 mp.weixin.qq.com）
    ↓ 调试模式启动（--user-data-dir + --remote-debugging-port=9222）
    ↓
Playwright connectOverCDP() 连接 127.0.0.1:9222
    ↓
互动管理 → 自动回复 → 关键词回复 → 添加 → 填规则名/关键词/匹配方式 → 添加回复 → 保存
```

## 配置（可选环境变量）

脚本**不写死任何账号凭据**；公众号 token 在运行时从已登录页面动态读取。
以下两个值可用环境变量覆盖（默认值即开箱可用，一般无需改）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | `http://127.0.0.1:9222` | Edge CDP 调试地址 |
| `OA_HOST` | `mp.weixin.qq.com` | 微信公众平台域名（换自建/测试域名时改） |

## 前置条件

1. 用户 Edge 已登录公众号后台（会话未过期；过期需扫码）
2. Node.js + `playwright-core` 可用
3. 若回复类型为「图文消息」，需**提前把要回复的文章发布到公众号**（草稿不行，必须是已发布素材）

## 使用流程

### 第1步：以调试模式启动 Edge

同 wechat-draft-publish-cdp skill 的 `start_edge_cdp.ps1`：
先杀光所有 msedge → 清理锁文件 → `--user-data-dir` + `--remote-debugging-port=9222` 启动（**不要** `--remote-debugging-address`）。
用户在此 Edge 窗口打开 `mp.weixin.qq.com` 并登录。

### 第2步：运行配置脚本

```bash
NODE_PATH="C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules" \
"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" \
setup_keyword.js "规则名" "关键词" "text" "回复文本内容"
# 或图文消息：
setup_keyword.js "规则名" "关键词" "news" "文章标题1,文章标题2"
```

- `text` 类型：脚本**可全自动**完成（填规则名/关键词/匹配方式 + 填文本 + 保存）。
- `news` 类型：脚本会填好规则名/关键词并打开「图文消息」选择器，但**文章勾选 + 最终保存常受「切换账号授权」弹窗阻断**，脚本会尽力关弹窗并停在选择器，剩余人工勾选 1~2 篇 + 点保存即可。

## 脚本模板（setup_keyword.js）

```javascript
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 配置（可用环境变量覆盖；默认本地 Edge CDP + 微信公众平台域名）
// ⚠️ 公众号 token 不在此处、也不写死：运行时从已登录页面动态读取
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OA_HOST = process.env.OA_HOST || 'mp.weixin.qq.com';

const RULE = process.argv[2] || '规则';
const KEYWORD = process.argv[3] || '关键词';
const TYPE = (process.argv[4] || 'text').toLowerCase(); // text | news
const CONTENT = process.argv[5] || ''; // text: 文本; news: 逗号分隔的已发布文章标题

// 关闭「切换账号授权」弹窗（文案含"我知道了"），多点几次
async function closeAccountDialog(page) {
  for (let i = 0; i < 3; i++) {
    const ik = page.locator('.weui-desktop-dialog').locator('text=我知道了').first();
    if (await ik.isVisible().catch(() => false)) { await ik.click(); await sleep(1000); }
    else break;
  }
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  let page = null;
  for (const ctx of browser.contexts())
    for (const p of ctx.pages())
      if (p.url().includes(OA_HOST)) page = p;
  if (!page) throw new Error('未找到公众号后台页面，请先登录');

  // 1) 导航：互动管理 → 自动回复 → 关键词回复
  await page.locator('text=互动管理').first().click(); await sleep(1500);
  await page.locator('text=自动回复').first().click(); await sleep(2000);
  await page.locator('text=关键词回复').first().click(); await sleep(2500);

  // 2) 添加规则
  await page.locator('button:has-text("添加")').first().click(); await sleep(2000);
  await closeAccountDialog(page);

  // 3) 填规则名 + 关键词（input[name=rule_name] / input[name="keyword[0]"]）
  await page.fill('input[name="rule_name"]', RULE);
  await page.fill('input[name="keyword[0]"]', KEYWORD);
  await sleep(500);

  // 3.1) 匹配方式：点开下拉选「半匹配」（若默认已对可跳过）
  const matchBtn = page.locator('text=匹配方式').locator('xpath=following-sibling::*[1]').first();
  // 若下拉结构不同，退化为：手动在界面点「半匹配」
  try {
    await matchBtn.click({ timeout: 3000 });
    await page.locator('text=半匹配').first().click({ timeout: 3000 });
  } catch (e) { console.log('⚠️ 匹配方式需手动选「半匹配」'); }
  await sleep(500);

  // 4) 添加回复
  await page.locator('button:has-text("添加回复")').first().click(); await sleep(2000);
  await closeAccountDialog(page);

  if (TYPE === 'text') {
    // 文本：等 textarea 出现并填入
    const ta = page.locator('textarea').last();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    await ta.fill(CONTENT);
    await sleep(800);
    await page.locator('text=保存').last().click();
    await sleep(2000);
    console.log('✓ 文本规则已保存');
  } else {
    // 图文：选「图文消息」后会出现文章选择器（弹窗）
    await page.locator('text=图文消息').first().click(); await sleep(2000);
    await closeAccountDialog(page);
    console.log('⏸ 已打开图文选择器，请人工勾选文章（' + CONTENT + '）并点确定/保存。');
    console.log('   （若弹出"切换账号授权"，点「我知道了」即可继续）');
    // 不自动关 browser，留给用户勾选
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
```

## ⚠️ 关键踩坑备忘

### 1. 「切换账号授权」弹窗是头号拦路虎
点击「添加回复」或选「图文消息」时，后台频繁弹出「未授权使用切换账号能力」安全提示（`.weui-desktop-dialog`，含"我知道了"按钮）。
**每次点开回复内容都会触发**，自动化点不进去。脚本用 `closeAccountDialog()` 循环关，但图文选择器里的勾选这一步仍可能被它打断。
→ **最稳做法**：文本规则全自动；图文规则用脚本开好表单后**人工勾选 + 保存**。

### 2. 新版后台菜单叫「互动管理」
旧的「内容与互动」已拆成侧边栏「互动管理」，自动回复在它下面。不要去搜"内容管理"。

### 3. input 选择器（实测）
| 字段 | 选择器 |
|------|----------|
| 规则名 | `input[name="rule_name"]` |
| 关键词（第1个） | `input[name="keyword[0]"]` |
| 添加规则按钮 | `button:has-text("添加")` |
| 添加回复按钮 | `button:has-text("添加回复")` |
| 匹配方式 | 下拉，文案"匹配方式"附近；退化方案：界面手动点「半匹配」 |

### 4. 图文消息必须选「已发布」文章
回复内容是「图文消息」时，选择器里**只列已发布素材**，草稿箱里的文章选不到。
所以【实战】这类要回多篇已发文章的，得先确认那些文章已发布（之前推草稿箱失败≠没发，用户可能手动发了）。

### 5. 回复方式：回复全部 vs 回复一条
若一条规则要回多篇图文（如【实战】回 2 篇），保存时注意选**「回复全部」**，否则只发第一篇。
（该选项在规则保存界面的"回复方式"下拉，脚本未自动设，可在人工勾选阶段一并确认。）

### 6. CDP 启动同 draft skill
Edge 调试端口起不来一律按 `start_edge_cdp.ps1` 的标准姿势：杀旧进程 + `--user-data-dir` + 端口，**不加** `--remote-debugging-address`。IPv6 问题用 `127.0.0.1`。

### 7. 截图会让 Node 进程崩
`page.screenshot()` 在此 Windows+Edge CDP 下可能进程级崩溃，生产脚本别用，改用 `page.evaluate` 读 DOM 确认。

## 运行环境

| 依赖 | 路径 |
|------|------|
| Node.js | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe` |
| playwright-core | `C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules` |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |

## 相关文件

| 文件 | 用途 |
|------|------|
| `start_edge_cdp.ps1` | 调试模式启动 Edge |
| `setup_keyword.js` | 连接 CDP → 导航 → 填规则 → （文本全自动 / 图文人工收尾） |
