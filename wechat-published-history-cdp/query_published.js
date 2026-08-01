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

// 把发表记录页 innerText 解析成结构化文章列表
function parseCatalog(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length);
  const arts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 日期行：今天 / 昨天 / 星期X / 2026年… / 07月26日（后台对更早的文章用「月日」格式，不带年）
    if (!/^(今天|昨天|星期|20\d{2}年|\d{1,2}月\d{1,2}日)/.test(line)) continue;
    const date = line;
    // 往后找状态行「已发表」
    let j = i + 1;
    if (j >= lines.length || lines[j] !== '已发表') continue;
    let k = j + 1;
    if (k >= lines.length) continue;
    let title = lines[k];
    let m = k + 1;
    if (title === '原创') {            // 跳过「原创」标记，标题在下一行
      title = lines[m];
      m = m + 1;
    }
    if (!title || /^\d+$/.test(title)) continue; // 标题不是数字才认
    const metrics = [];
    while (m < lines.length && /^\d+$/.test(lines[m])) { metrics.push(parseInt(lines[m], 10)); m++; }
    arts.push({
      date,
      title,
      views: metrics[0] || 0,
      likes: metrics[1] || 0,
      comments: metrics[2] || 0,
      shares: metrics[3] || 0,
    });
    i = m - 1; // 跳过已消费的数字行
  }
  return arts;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  log('connected');
  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages.find(p => p.url().includes('mp.weixin.qq.com')) || null;
  if (!page) page = await context.newPage();
  log('page: ' + page.url());

  let token = '';
  const mt = page.url().match(/token=(\d+)/);
  if (mt) token = mt[1];
  log('TOKEN: ' + (token || '(none)'));
  if (!token) { log('NO TOKEN - 请先在 Edge 打开 mp.weixin.qq.com 并登录'); clearTimeout(killer); process.exit(0); }

  const all = [];
  let begin = 0;
  let pagesFetched = 0;
  let lastFirstTitle = '';
  while (pagesFetched < MAX_PAGES) {
    const url = `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=${begin}&count=${COUNT}&token=${token}&lang=zh_CN`;
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
    catch (e) { log('goto ERR ' + e.message); }
    log('goto begin=' + begin);
    await sleep(12000); // 微信后台长轮询，等足 12 秒
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const batch = parseCatalog(text);
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

  // 关键词筛选
  const shown = FILTER ? all.filter(a => a.title.includes(FILTER)) : all;

  const txtFile = path.join(OUT_DIR, 'published_catalog.txt');
  const mdFile = path.join(OUT_DIR, 'published_catalog.md');
  const lines = shown.map((a, i) =>
    `${i + 1}. [${a.date}] ${a.title}  (阅读 ${a.views} / 赞 ${a.likes} / 评论 ${a.comments} / 分享 ${a.shares})`);
  fs.writeFileSync(txtFile, lines.join('\n') + '\n');
  const md = '# 已发表文章目录\n\n' +
    `共抓到 ${all.length} 篇` + (FILTER ? `，筛选「${FILTER}」命中 ${shown.length} 篇` : '') + '\n\n' +
    '| # | 日期 | 标题 | 阅读 | 赞 | 评论 | 分享 |\n|---|------|------|------|----|------|------|\n' +
    shown.map((a, i) => `| ${i + 1} | ${a.date} | ${a.title} | ${a.views} | ${a.likes} | ${a.comments} | ${a.shares} |`).join('\n') + '\n';
  fs.writeFileSync(mdFile, md);

  console.log('TOTAL_FETCHED=' + all.length + (FILTER ? `  FILTER_MATCH=${shown.length}` : ''));
  console.log(lines.join('\n'));
  clearTimeout(killer);
  process.exit(0);
})().catch(e => { log('FATAL ' + (e && e.message)); clearTimeout(killer); process.exit(1); });
