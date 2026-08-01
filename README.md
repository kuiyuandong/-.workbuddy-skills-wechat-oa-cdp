# -.workbuddy-skills-wechat-oa-cdp

WorkBuddy 技能集：通过 **Edge 浏览器 CDP（远程调试协议）+ Playwright**，把文章自动推送进微信公众号草稿箱、并批量配置「关键词自动回复」。

适用于：**未认证订阅号**（没有 API 群发/发布权限）时，借用已登录的浏览器会话完成发布动作。

## 包含三个技能

| 技能 | 目录 | 用途 |
|------|------|------|
| 草稿箱发布 | [`wechat-draft-publish-cdp/`](./wechat-draft-publish-cdp) | 把本地 `.docx/.doc/.txt/.md` 文章自动导入公众号草稿箱（新版编辑器走「文档导入」） |
| 关键词自动回复 | [`wechat-keyword-reply-cdp/`](./wechat-keyword-reply-cdp) | 在公众号后台批量配置关键词规则 |
| 已发表目录查询 | [`wechat-published-history-cdp/`](./wechat-published-history-cdp) | 直连后台「发表记录」抓取已发表文章目录（标题/日期/阅读/赞/评论/分享），支持翻页+关键词筛选，用于为新文章找可链接的历史稿 |

## 前置条件

- Windows + **Microsoft Edge**（用其 CDP，不用 Chrome——Chrome 148 的 CDP 要求非默认 user-data-dir，拿不到登录态）
- 已登录公众号后台的 Edge 会话
- Node.js（Playwright 走 `connectOverCDP`）+ Python（`.md → .docx` 转换）
- 详细步骤见各技能目录内的 `SKILL.md`

## 已知限制

- 公众号后台「切换账号」安全弹窗无法被自动化绕过 → 关键词配置若遇该弹窗需人工点掉
- 未认证订阅号无 API 发布权限，故本方案走浏览器会话而非微信 API

## 安全说明

- **本仓库不含任何账号凭据**：公众号 `token` 不在代码里、也不写死——运行时由脚本从已登录的公众号后台页面动态提取（`getToken()`）。
- 仓库内仅有的"常量"是两个**非敏感**默认值：`CDP_URL=http://127.0.0.1:9222`（本地 Edge 调试端口）与 `OA_HOST=mp.weixin.qq.com`（微信公众平台公开域名），均可用环境变量覆盖。
