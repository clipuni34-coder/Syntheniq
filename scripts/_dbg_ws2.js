const puppeteer = require('puppeteer');
const fs = require('fs');
(async () => {
  const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
  const lotteryTok = loginData.data.lotteryLoginUrl.match(/Token=([^&]+)/)[1];
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--window-size=414,896','--ignore-certificate-errors','--disable-web-security'], ignoreHTTPSErrors:true});
  const page = await browser.newPage();
  page.on('console', m => console.log('[C]', m.text().substring(0,200)));
  page.on('websocket', ws => {
    console.log('*** CDP WS opened:', ws.url());
    ws.on('framesent', e => console.log('  -> SEND', e.payload.substring(0,300)));
    ws.on('framereceived', e => console.log('  <- RECV', e.payload.substring(0,800)));
    ws.on('socketclose', (c,r) => console.log('  WS closed', c, r));
  });
  // Constructor override
  await page.evaluateOnNewDocument(() => {
    const Orig = window.WebSocket;
    window.webSocketList = [];
    window.WebSocket = function(url, protocols){
      const ws = new Orig(url, protocols);
      const idx = window.webSocketList.length;
      window.webSocketList.push({url, protocol: protocols||'(none)', readyState: ws.readyState});
      console.log('[WS CTOR] Opening:', url, protocols||'');
      const s = ws.send.bind(ws);
      ws.send = function(d){ console.log('[WS SEND]', (d&&d.toString)?d.toString().substring(0,500):d); return s(d);};
      ws.addEventListener('open',()=>console.log('[WS OPEN]', url));
      ws.addEventListener('message',e=>{ console.log('[WS RECV]', (e.data&&e.data.toString)?e.data.toString().substring(0,800):e.data);
        window.webSocketList[idx].received = (window.webSocketList[idx].received||[]).concat(e.data.toString());
      });
      return ws;
    };
    window.WebSocket.prototype = Orig.prototype;
  });
  const url = 'https://h5.ar-lottery01.com/?Token=' + encodeURIComponent(lotteryTok);
  console.log('Loading:', url);
  try { await page.goto(url, {waitUntil:'networkidle2',timeout:30000}); } catch(e){ console.log('goto err', e.message);}
  console.log('title:', await page.title());
  // also directly navigate to winGo game page on the sub-app
  await page.goto('https://h5.ar-lottery01.com/#/saasLottery/WinGo?gameCode=WinGo_30S&lottery=WinGo', {waitUntil:'networkidle2',timeout:30000}).catch(e=>console.log('goto2 err',e.message));
  console.log('waiting 30s...');
  await new Promise(r=>setTimeout(r,30000));
  const data = await page.evaluate(()=>({list: window.webSocketList||[]}));
  console.log('Ctor-captured WS count:', data.list.length);
  fs.writeFileSync('/tmp/wingo_ws_intercept2.json', JSON.stringify({cdpTracked:'see-above',ctor:data.list},null,2));
  await browser.close();
  console.log('done');
})().catch(e=>{ console.error('FATAL',e.message); process.exit(1);});
