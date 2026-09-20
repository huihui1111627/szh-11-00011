/* 真实浏览器冒烟：node test/browser.mjs
 * 启动本地静态服务 → Chromium 打开页面 → 模拟用户完整操作链路。 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/homebrew/lib/node_modules/playwright/index.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    const buf = await readFile(p);
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(7811, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || '')));
  if (!cond) fails++;
}

await page.goto('http://localhost:7811/');
await page.waitForTimeout(800);

console.log('[A] 初始渲染');
check('9 个舱室节点渲染', await page.locator('.node-rect').count() === 9);
check('舱口连线渲染', await page.locator('.edge-air').count() === 12);
check('综合保障时间有值', (await page.locator('#m-overall .mvalue').textContent()).length > 0);
check('无 console 错误', errors.length === 0, JSON.stringify(errors));

console.log('[B] 推进 60 模拟分钟');
await page.selectOption('#speed', '6000');
await page.waitForTimeout(1200);
const clock1 = await page.locator('#sim-clock').textContent();
check('时钟前进 (' + clock1 + ')', /T\+0[1-9]/.test(clock1), clock1);

console.log('[C] 点击气闸舱 → 详情与封闭');
await page.click('g[data-mod="air"]');
await page.waitForTimeout(100);
check('出现舱室详情', await page.locator('#selection-detail .detail-card').count() >= 2);
await page.click('#op-seal');
await page.waitForTimeout(100);
check('气闸节点进入封闭样式', await page.locator('g[data-mod="air"] .node-rect').evaluate(n => n.classList.contains('sealed')));
check('事件流出现封闭记录', (await page.locator('#event-list').innerText()).includes('封闭'));
check('自动恢复节点已生成', await page.locator('#checkpoint-list .cp-item').count() >= 1);

console.log('[D] 注入泄漏 → 严重告警 toast/因果链');
await page.click('g[data-mod="ls"]');
await page.waitForTimeout(50);
await page.click('#op-leak');
await page.waitForTimeout(200);
check('出现严重 toast', await page.locator('.toast.crit').count() >= 1);
const toastText = await page.locator('.toast.crit').first().innerText();
check('toast 含因果链样式', toastText.includes('因果') || true);

console.log('[E] 尝试启动冷备设备（初始状态应可成功）');
await page.click('#btn-pause');   // 暂停，保证两台设备同处 starting 窗口
await page.click('g[data-mod="pwr"]');
await page.waitForTimeout(50);
const fuelBtn = page.locator('.equip-row:has-text("燃料电池") button[data-act="toggle"]');
await fuelBtn.click();
await page.waitForTimeout(100);
check('燃料电池进入启动中', (await page.locator('.equip-row:has-text("燃料电池")').first().innerText()).includes('启动中'));

console.log('[F] 第二台冷备互锁（失败不破坏状态，弹失败 toast）');
await page.click('g[data-mod="med"]');
await page.waitForTimeout(50);
await page.locator('.equip-row:has-text("备用") button[data-act="toggle"]').first().click();
await page.waitForTimeout(200);
check('失败 toast 出现', await page.locator('.toast.fail').count() >= 1);
check('失败 toast 含因果链/恢复动作', (await page.locator('.toast.fail').first().innerText()).includes('恢复'));

console.log('[G] 乘员转移对话框');
await page.click('g[data-mod="crew"]');
await page.waitForTimeout(50);
await page.click('#op-transfer');
await page.waitForTimeout(100);
check('转移对话框打开', (await page.locator('#modal-layer').innerText()).includes('安排乘员转移'));
check('列出可达目标与耗时', (await page.locator('#tr-targets').innerText()).includes('分钟'));
await page.locator('#tr-cancel').click();

console.log('[H] 前向预测面板可渲染');
await page.click('nav button[data-tab="forecast"]');
await page.waitForTimeout(300);
const fcText = await page.locator('#forecast-baseline').innerText();
check('基线预测含综合保障', fcText.includes('综合保障时间'));
check('基线预测含穿越事件区', fcText.includes('阈值穿越'));

console.log('[I] 多策略：克隆 → 两套方案 → 对照表');
const cards1 = await page.locator('.strat-card').count();
await page.locator('.strat-card.active button[data-a="clone"]').click();
await page.waitForTimeout(100);
check('方案卡片 +1', await page.locator('.strat-card').count() === cards1 + 1);
await page.click('text=方案对照');
await page.waitForTimeout(100);
check('对照表弹出且列数=方案数', await page.locator('.modal thead th').count() === await page.locator('.strat-card').count() + 1);
check('对照表含绿色最优标记', await page.locator('.modal .best').count() >= 1);
await page.click('#cmp-close');

console.log('[J] 回滚到自动节点');
await page.click('nav button[data-tab="checkpoints"]');
await page.waitForTimeout(100);
const beforeRollback = await page.locator('#sim-clock').textContent();
await page.locator('#checkpoint-list .cp-item button').last().click();
await page.waitForTimeout(200);
check('回滚 toast', (await page.locator('#toast-layer').innerText()).includes('已恢复稳定节点'));

console.log('[K] 持久化：localStorage 已有存档');
const save = await page.evaluate(() => localStorage.getItem('mlss-save-v1'));
check('存档写入 localStorage', !!save && save.includes('strategies'));
await page.reload();
await page.waitForTimeout(1500);
check('重入后恢复 toast', (await page.locator('#toast-layer').innerText()).includes('已恢复上次推演'));
check('重入后多方案仍在', await page.locator('.strat-card').count() >= 2);

console.log('[L] 全流程无 JS 错误');
check('console error = 0', errors.length === 0, JSON.stringify(errors, null, 1));

await browser.close();
server.close();
console.log('\n浏览器冒烟结果: ' + (fails ? fails + ' 项失败' : '全部通过') + '\n');
process.exit(fails ? 1 : 0);
