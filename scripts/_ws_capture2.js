const WebSocket = require('ws');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const wsUrl = loginData.data.webSocketUrl;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
const origins = ['https://fb999.com','https://h5.ar-lottery01.com','https://fb999.win','https://fb999-fb999.com'];

async function tryOrigin(origin){
  return new Promise((resolve)=>{
    console.log('\n--- try origin:', origin, '---');
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin }, protocol: 'websocket' });
    const sent=[], recv=[];
    let opened=false;
    const t = setTimeout(()=>{ try{ws.terminate();}catch(e){} resolve({origin,opened,received:recv.length}); }, 12000);
    ws.on('open',()=>{
      opened=true; console.log('*** OPEN (origin',origin+')');
      let i=0;
      const msgs=[
        JSON.stringify({type:'subscribe',channel}),
        JSON.stringify({type:'subscribe',topic:channel}),
        JSON.stringify({type:'subscribe',destination:channel}),
        JSON.stringify({action:'subscribe',channel}),
        JSON.stringify({type:'join',channel}),
        JSON.stringify({type:'init',token:loginData.data.token}),
        JSON.stringify({type:'auth',token:loginData.data.token}),
        JSON.stringify({type:'heartbeat'}),
      ];
      const iv=setInterval(()=>{
        if(i>=msgs.length){clearInterval(iv); return;}
        const m=msgs[i++]; ws.send(m); sent.push(m);
        console.log('  -> SEND', m.substring(0,160));
      },500);
      const pk=setInterval(()=>{try{ws.ping();}catch(e){}},10000);
      // capture for 8s then close
      setTimeout(()=>{
        clearInterval(pk); clearInterval(iv);
        try{ws.close();}catch(e){}
      }, 7500);
    });
    ws.on('message',(d)=>{const s=d.toString();recv.push(s);console.log('  <- RECV ('+s.length+'b):',s.substring(0,500));});
    ws.on('error',(e)=>{console.log('  ERR:',e.message); try{ws.terminate();}catch(e){}});
    ws.on('close',()=>{clearTimeout(t); if(opened)console.log('  closed. recv='+recv.length); resolve({origin,opened,received:recv.length,recv,sent});});
  });
}

(async()=>{
  const results=[];
  for(const o of origins){
    const r = await tryOrigin(o);
    results.push({origin: r.origin, opened: r.opened, received: r.received});
    if(r.opened && r.received>0){
      console.log('\n*** SUCCESS on origin', o, 'with', r.received, 'messages ***');
      fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
        originalWebSockets:[{url:wsUrl, protocol:'websocket', opened:true, origin:o, sentMessages:r.sent, receivedMessages:r.recv}],
        winGoMessages: (r.recv||[]).filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue');}),
        targetUrl: wsUrl, channel,
      },null,2));
      console.log('Saved 30s-ish capture to /tmp/wingo_ws_intercept.json (will rewrite with full 30s below)');
      break;
    }
  }
  console.log('\n=== ORIGIN TRIAL SUMMARY ===');
  console.table(results);
  console.log('token exp (ms):', loginData.data.webSocketTokenExpireAt, '->', new Date(loginData.data.webSocketTokenExpireAt).toISOString());
  console.log('now:', new Date().toISOString());
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
