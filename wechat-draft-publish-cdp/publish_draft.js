// publish_draft.js
// 通过 Edge CDP 将本地 .docx/.doc/.txt 文章发布到公众号草稿箱
// 用法:
//   NODE_PATH="C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules" \
//   "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.12.0\node.exe" \
//   publish_draft.js "C:\路径\文章.docx" "文章标题"
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 配置（可用环境变量覆盖；默认本地 Edge CDP + 微信公众平台域名）
// ⚠️ 公众号 token 不在此处、也不写死：运行时从已登录页面动态提取（见 getToken）
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OA_HOST = process.env.OA_HOST || 'mp.weixin.qq.com';

const DOCX = process.argv[2] || 'article.docx';
const TITLE = process.argv[3] || '未命名文章';

// 从已登录页面提取 token（避免硬编码）
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

  // 1) 进入草稿箱列表（type=77 = 草稿）
  if (!page.url().includes('type=77')) {
    const token = await getToken(page);
    const url = `https://${OA_HOST}/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card`
      + (token ? `&token=${token}` : '') + '&lang=zh_CN';
    await page.goto(url, { waitUntil: 'networkidle' });
    await sleep(3000);
  }

  // 2) 新的创作 -> 文章
  await page.locator('text=新的创作').first().click();
  await sleep(1500);
  await page.locator('.weui-desktop-dropdown__list-ele:has-text("文章")').first().click();
  await sleep(3000);

  // 3) 文档导入（只认 .doc/.docx/.txt；.md 会报"不支持该格式"）
  await page.locator('li.media_extra_item.import_file').first().click();
  await sleep(2000);
  // ★ 页面有 2 个 input[type=file]：第1个是封面图，第2个才是文档导入
  const fileInput = page.locator('input[type=file][accept*="wordprocessingml.document"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 8000 });
  await fileInput.setInputFiles(DOCX);
  await sleep(8000); // 上传 + 后台转换

  // 关掉可能弹出的「切换账号授权」提示
  const ik = page.locator('.weui-desktop-dialog').locator('text=我知道了').first();
  if (await ik.isVisible().catch(() => false)) { await ik.click(); await sleep(1000); }

  // 4) 填标题（真实 textarea#title 被隐藏，用 JS 注入）
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
