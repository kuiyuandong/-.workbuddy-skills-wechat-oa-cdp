const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const OUT_DIR = process.env.OUT_DIR || process.cwd();
const FILTER = process.argv[2] || '';           // 可选：只显示标题含此关键词的文章
const MAX_PAGES = parseInt(process.argv[3] || '20', 10); // 安全上限（每页20条 → 最多400条）
const COUNT = 20;

const DIAG = path.join(OUT_DIR, 'query_published_diag.txt');
fs.writeFileSync(DIAG, 'START ' + new Date().toISOString() + '\n');
const log = m => fs.appendFileSync(DIAG, m + '\n');
const killer = setTimeout(() => { log('GLOBAL_TIMEOUT'); process.exit(2); }, 180000);

// 从发表记录页 DOM 直接提取每篇已发文章的卡片：标题 + 真实对外链接 + 数据
// 文章卡片容器 class 为 .weui-desktop-mass-appmsg，标题 <a href="https://mp.weixin.qq.com/s/...">
// 注意：之前用 innerText 解析会丢失链接（链接不在可见文本里），必须读 DOM。
async function fetchPageCards(page, begin, token) {
  const url = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=${begin}&count=${COUNT}&token=${token}&lang=zh_CN`;
  try {
    await page.goto('about:blank'); // 强制清空 SPA，避免复用 tab 时分页不刷新（否则 begin 参数被忽略 → 重复页）
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) { log('goto ERR ' + e.message); }
  log('goto begin=' + begin);
  await sleep(13000); // 微信后台长轮询，等足 13 秒加载新页
  if (begin === 0) {
    const t = await page.evaluate(() => document.body ? document.body.innerText : '');
    fs.writeFileSync(path.join(OUT_DIR, 'published_innertext_last.txt'), t);
  }
  const cards = await page.evaluate(() => {
    const out = [];
    // 1) DOM 提取标题 + 真实链接 + 数据（链接在 <a href="mp.weixin.qq.com/s/..."> 上，innerText 里没有）
    document.querySelectorAll('.weui-desktop-mass-appmsg').forEach(card => {
      const a = card.querySelector('a[href*="mp.weixin.qq.com/s/"]');
      if (!a) return;
      const span = a.querySelector('span');
      const title = (span ? span.textContent : a.textContent).trim();
      if (!title) return;
      const url = a.getAttribute('href');
      const nums = Array.from(card.querySelectorAll('[class*="data__inner"]')).map(n => parseInt((n.textContent || '').trim(), 10) || 0);
      out.push({ title, url, views: nums[0] || 0, likes: nums[1] || 0, comments: nums[2] || 0, shares: nums[3] || 0 });
    });
    // 2) 日期在卡片外的列表项层（DOM 卡片不含日期文本），改用整页 innerText 按「已发表」锚点解析 标题→日期 映射
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length);
    const isDate = s => /^(今天|昨天|星期|20\d{2}年|\d{1,2}月\d{1,2}日)/.test(s);
    const dateMap = {};
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== '已发表') continue;
      let date = '';
      for (let j = i - 1; j >= 0 && j >= i - 6; j--) { if (isDate(lines[j])) { date = lines[j]; break; } }
      if (!date) continue;
      let k = i + 1; if (lines[k] === '原创') k = i + 2;
      let title = '';
      if (lines[k] && !/^\d+$/.test(lines[k]) && lines[k] !== '已发表') title = lines[k];
      else if (lines[i - 1] && !isDate(lines[i - 1]) && lines[i - 1] !== '已发表') title = lines[i - 1];
      if (title) dateMap[title] = date;
    }
    return out.map(o => ({ ...o, date: dateMap[o.title] || '' }));
  });
  return cards;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  log('connected');
  const context = browser.contexts()[0];
  // token 从任一已登录的 mp 页面 URL 取（后台各页 URL 都带 token 参数）
  let token = '';
  for (const p of context.pages()) {
    const m = (p.url() || '').match(/token=(\d+)/);
    if (m) { token = m[1]; break; }
  }
  // 抓取用全新 tab，避免复用旧 tab 时 SPA 路由状态错位（首次探査因此抓错页面）
  const page = await context.newPage();
  log('page: ' + page.url());

  log('TOKEN: ' + (token || '(none)'));
  if (!token) { log('NO TOKEN - 请先在 Edge 打开 mp.weixin.qq.com 并登录'); clearTimeout(killer); process.exit(0); }

  const all = [];
  let begin = 0;
  let pagesFetched = 0;
  let lastFirstTitle = '';
  while (pagesFetched < MAX_PAGES) {
    const batch = await fetchPageCards(page, begin, token); // 内部已做 about:blank + goto + sleep，勿在此重复
    log(`page begin=${begin}: parsed ${batch.length}`);
    if (batch.length === 0) break;
    // 翻页去重：若本页首篇与上页首篇相同，说明 begin 参数未生效，停止翻页
    if (batch[0].title === lastFirstTitle) { log('DUPLICATE PAGE - 停止翻页'); break; }
    lastFirstTitle = batch[0].title;
    all.push(...batch);
    pagesFetched++;
    if (batch.length < COUNT) break; // 已到末页
    begin += COUNT;
  }

  // 翻页可能抓到重叠文章 → 按标题去重（保留首次出现）
  const seen = new Set();
  const deduped = [];
  for (const a of all) { if (seen.has(a.title)) continue; seen.add(a.title); deduped.push(a); }
  log('after dedup: ' + deduped.length + ' (was ' + all.length + ')');
  // 关键词筛选
  const shown = FILTER ? deduped.filter(a => a.title.includes(FILTER)) : deduped;

  const txtFile = path.join(OUT_DIR, 'published_catalog.txt');
  const mdFile = path.join(OUT_DIR, 'published_catalog.md');
  const jsonFile = path.join(OUT_DIR, 'published_catalog.json');
  const lines = shown.map((a, i) =>
    `${i + 1}. [${a.date}] ${a.title}  (阅读 ${a.views} / 赞 ${a.likes} / 评论 ${a.comments} / 分享 ${a.shares})  ${a.url}`);
  fs.writeFileSync(txtFile, lines.join('\n') + '\n');
  const md = '# 已发表文章目录\n\n' +
    `共抓到 ${all.length} 篇` + (FILTER ? `，筛选「${FILTER}」命中 ${shown.length} 篇` : '') + '\n\n' +
    '| # | 日期 | 标题 | 阅读 | 赞 | 评论 | 分享 | 链接 |\n|---|------|------|------|----|------|------|------|\n' +
    shown.map((a, i) => `| ${i + 1} | ${a.date} | ${a.title} | ${a.views} | ${a.likes} | ${a.comments} | ${a.shares} | [打开](${a.url}) |`).join('\n') + '\n';
  fs.writeFileSync(mdFile, md);
  fs.writeFileSync(jsonFile, JSON.stringify(shown, null, 2));

  console.log('TOTAL_FETCHED=' + all.length + (FILTER ? `  FILTER_MATCH=${shown.length}` : ''));
  console.log(lines.join('\n'));
  clearTimeout(killer);
  process.exit(0);
})().catch(e => { log('FATAL ' + (e && e.message)); clearTimeout(killer); process.exit(1); });
