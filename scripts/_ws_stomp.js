const WebSocket = require('ws');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const wsUrl = loginData.data.webSocketUrl;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
console.log('WS URL:', wsUrl.substring(0,80)+'...');
console.log('Channel:', channel);

const ws = new WebSocket(wsUrl, 'stomp', { headers:{Origin:'https://fb999.com'}, perMessageExtensions:false });
const sent=[], recv=[];
let opened=false;
const NUL='\x00';

ws.on('open',()=>{
  opened=true;
  console.log('*** WebSocket OPEN (stomp) ***');
  // STOMP CONNECT
  const connectFrame = 'CONNECT\naccept-version:1.2\nhost:pro-v3-payplatform.admin-broadcast.com\nlogin:\n passcode:\n\n' + NUL;
  ws.send(connectFrame); sent.push(connectFrame);
  console.log('  -> SEND CONNECT');
  setTimeout(()=>{
    const subFrame = 'SUBSCRIBE\ndestination:'+channel+'\nid:1\nack:auto\n\n' + NUL;
    ws.send(subFrame); sent.push(subFrame);
    console.log('  -> SEND SUBSCRIBE to', channel);
    // also try the WinGo channel variants
    setTimeout(()=>{
      const v=[];
      ['/WebApi/1004/lottery/WinGo_30S','/WebApi/1004/game/WinGo_30S','/WebGo/WinGo_30S','/Lottery/WinGo_30S','/WebApi/1004/userid/364070'].forEach((c,i)=>{
        const f='SUBSCRIBE\ndestination:'+c+'\nid:'+(i+2)+'\nack:auto\n\n'+NUL;
        v.push(f); ws.send(f);
      });
      sent.push(...v);
      console.log('  -> SENT', v.length, 'extra subscriptions');
    },3000);
  },1500);
});

ws.on('message',(data)=>{
  const s=data.toString(); recv.push(s);
  const ts=new Date().toISOString().substring(11,19);
  console.log(`[${ts}] <- RECV (${s.length}b):`);
  console.log(s.substring(0,700));
});

ws.on('pong',()=>console.log('  <- PONG'));
ws.on('error',e=>console.log('WS ERROR:',e.message));
ws.on('close',(c,r)=>console.log('WS CLOSED',c,r.toString().substring(0,80)));

const pk=setInterval(()=>{ try{ws.ping();}catch(e){} },12000);
setTimeout(()=>{
  clearInterval(pk);
  try{ws.close();}catch(e){}
  const interesting = recv.filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue');});
  const out={
    targetUrl:wsUrl, protocol:'stomp', channel, opened,
    sentMessages:sent, receivedCount:recv.length, receivedMessages:recv,
    interestingMessages:interesting,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets:[{url:wsUrl,protocol:'stomp',opened,channel,subscribed:true,sentMessages:sent,receivedMessages:recv}],
    winGoMessages:interesting,
  },null,2));
  console.log('\n=== SUMMARY ===');
  console.log('Opened:', open, 'Received:', recv.length, 'Interesting:', interesting.length);
  process.exit(0);
}, 30000);
