// setup_keyword.js
// 通过 Edge CDP 在公众号后台配置「关键词自动回复」
// 用法:
//   文本回复: node setup_keyword.js "规则名" "关键词" "text" "回复文本内容"
//   图文回复: node setup_keyword.js "规则名" "关键词" "news" "已发布文章标题1,已发布文章标题2"
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 配置（可用环境变量覆盖；默认本地 Edge CDP + 微信公众平台域名）
// ⚠️ 公众号 token 不在此处、也不写死：运行时从已登录页面动态读取
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OA_HOST = process.env.OA_HOST || 'mp.weixin.qq.com';

const RULE = process.argv[2] || '规则';
const KEYWORD = process.argv[3] || '关键词';
const TYPE = (process.argv[4] || 'text').toLowerCase(); // text | news
const CONTENT = process.argv[5] || '';

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

  // 1) 导航：互动管理 -> 自动回复 -> 关键词回复
  await page.locator('text=互动管理').first().click(); await sleep(1500);
  await page.locator('text=自动回复').first().click(); await sleep(2000);
  await page.locator('text=关键词回复').first().click(); await sleep(2500);

  // 2) 添加规则
  await page.locator('button:has-text("添加")').first().click(); await sleep(2000);
  await closeAccountDialog(page);

  // 3) 填规则名 + 关键词
  await page.fill('input[name="rule_name"]', RULE);
  await page.fill('input[name="keyword[0]"]', KEYWORD);
  await sleep(500);

  // 3.1) 匹配方式：尝试点开下拉选「半匹配」
  try {
    const matchBtn = page.locator('text=匹配方式').locator('xpath=following-sibling::*[1]').first();
    await matchBtn.click({ timeout: 3000 });
    await page.locator('text=半匹配').first().click({ timeout: 3000 });
  } catch (e) { console.log('⚠️ 匹配方式需手动选「半匹配」'); }
  await sleep(500);

  // 4) 添加回复
  await page.locator('button:has-text("添加回复")').first().click(); await sleep(2000);
  await closeAccountDialog(page);

  if (TYPE === 'text') {
    const ta = page.locator('textarea').last();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    await ta.fill(CONTENT);
    await sleep(800);
    await page.locator('text=保存').last().click();
    await sleep(2000);
    console.log('✓ 文本规则已保存');
  } else {
    await page.locator('text=图文消息').first().click(); await sleep(2000);
    await closeAccountDialog(page);
    console.log('⏸ 已打开图文选择器，请人工勾选文章（' + CONTENT + '）并点确定/保存。');
    console.log('   （若弹出"切换账号授权"，点「我知道了」即可继续）');
    // 不自动关 browser，留给用户勾选
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
