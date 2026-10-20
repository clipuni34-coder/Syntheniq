const puppeteer = require('puppeteer');
const fs = require('fs');
(async () => {
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--window-size=414,896','--ignore-certificate-errors','--disable-web-security'], ignoreHTTPSErrors:true});
  const page = await browser.newPage();
  page.on('console', m => console.log('[PAGE CONSOLE]', m.text().substring(0,200)));
  page.on('websocket', ws => {
    console.log('*** CDP WS opened:', ws.url());
    ws.on('framesent', e => console.log('  -> SEND', e.payload.substring(0,300)));
    ws.on('framereceived', e => console.log('  <- RECV', e.payload.substring(0,500)));
    ws.on('socketclose', () => console.log('  WS closed'));
  });
  const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
  // inject token before load
  await page.evaluateOnNewDocument((tok, reftok, wsUrl, wsCh) => {
    localStorage.setItem('token', tok); localStorage.setItem('refreshToken', reftok);
    localStorage.setItem('tokenHeader','Bearer '); localStorage.setItem('ar_token', tok);
    localStorage.setItem('ar_ws_url', wsUrl); localStorage.setItem('ar_ws_channels', wsCh);
  }, loginData.data.token, loginData.data.refreshToken, loginData.data.webSocketUrl, JSON.stringify(loginData.data.webSocketChannels));
  console.log('goto fb999 with token pre-injected');
  try { await page.goto('https://fb999.com', {waitUntil:'networkidle2',timeout:30000}); } catch(e){ console.log('goto1 err', e.message); }
  console.log('title:', await page.title());
  const body0 = await page.content().then(h=>h.substring(0,300));
  console.log('body snippet:', body0.replace(/\n/g,' ').substring(0,300));
  await page.goto('https://fb999.com/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo', {waitUntil:'networkidle2',timeout:30000}).catch(e=>console.log('goto2 err',e.message));
  console.log('waiting 25s...');
  await new Promise(r=>setTimeout(r,25000));
  console.log('done waiting');
  await browser.close();
})().catch(e=>{ console.error('FATAL',e.message); process.exit(1);});
