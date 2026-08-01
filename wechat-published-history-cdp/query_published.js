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
// 鲁棒策略：以「已发表」状态行为锚点，往回找最近日期行，往后抓标题与连续数字指标。
// （之前的版本从日期行往后硬找「已发表」，遇到微信把标题/数字行顺序微调就漏抓数字 → 全 0）
function parseCatalog(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length);
  const isDate = s => /^(今天|昨天|星期|20\d{2}年|\d{1,2}月\d{1,2}日)/.test(s);
  const isNum = s => /^\d+$/.test(s);
  const arts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '已发表') continue;
    // 日期：往前最近一个日期行
    let date = '';
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      if (isDate(lines[j])) { date = lines[j]; break; }
    }
    if (!date) continue;
    // 标题：优先「已发表」后一行；若是「原创」则再后一行；若后一行是数字（标题在已发表前），取前一行
    let title = '';
    let k = i + 1;
    if (lines[k] === '原创') k = i + 2;
    if (lines[k] && !isNum(lines[k]) && lines[k] !== '已发表') title = lines[k];
    else if (lines[i - 1] && !isDate(lines[i - 1]) && lines[i - 1] !== '已发表') title = lines[i - 1];
    if (!title) continue;
    // 数字指标：从标题行往后，跳过「原创」等非数字标记，收集连续数字行（阅读/赞/评论/分享…）
    const metrics = [];
    let m = (lines[k] === title) ? k + 1 : i + 1;
    while (m < lines.length) {
      if (isNum(lines[m])) metrics.push(parseInt(lines[m], 10));
      else if (metrics.length > 0) break; // 数字收齐后遇到非数字（下一篇）才停
      m++;
    }
    arts.push({
      date,
      title,
      views: metrics[0] || 0,
      likes: metrics[1] || 0,
      comments: metrics[2] || 0,
      shares: metrics[3] || 0,
    });
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
    try {
      await page.goto('about:blank'); // 强制清空 SPA，避免复用 tab 时分页不刷新（否则 begin 参数被忽略 → 重复页）
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    catch (e) { log('goto ERR ' + e.message); }
    log('goto begin=' + begin);
    await sleep(13000); // 微信后台长轮询，等足 13 秒加载新页
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    if (begin === 0) fs.writeFileSync(path.join(OUT_DIR, 'published_innertext_last.txt'), text);
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

  // 翻页可能抓到重叠文章 → 按标题去重（保留首次出现）
  const seen = new Set();
  const deduped = [];
  for (const a of all) { if (seen.has(a.title)) continue; seen.add(a.title); deduped.push(a); }
  log('after dedup: ' + deduped.length + ' (was ' + all.length + ')');
  // 关键词筛选
  const shown = FILTER ? deduped.filter(a => a.title.includes(FILTER)) : deduped;

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
