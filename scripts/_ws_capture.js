const WebSocket = require('ws');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const wsUrl = loginData.data.webSocketUrl;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
console.log('Target WS URL:', wsUrl.substring(0,90)+'...');
console.log('Channel:', channel);

const ws = new WebSocket(wsUrl);
const sent = [];
const recv = [];
let open = false;

ws.on('open', () => {
  open = true;
  console.log('*** WebSocket OPEN');
  // Try several subscribe/auth formats the app/backend might expect
  const msgs = [
    // STOMP-like
    'SUBSCRIBE\nchannel:'+channel+'\n\n^@',
    // JSON subscribe variants
    JSON.stringify({type:'subscribe', channel}),
    JSON.stringify({type:'subscribe', topic:channel}),
    JSON.stringify({type:'subscribe', destination:channel}),
    JSON.stringify({action:'subscribe', channel}),
    JSON.stringify({type:'join', channel}),
    JSON.stringify({subscribe:channel}),
    JSON.stringify({type:'sub', channel}),
    // init/auth
    JSON.stringify({type:'init', token: loginData.data.token}),
    JSON.stringify({type:'auth', token: loginData.data.token}),
    JSON.stringify({type:'login', token: loginData.data.token, userId:364070, tenant:1004}),
    // heartbeat
    JSON.stringify({type:'heartbeat'}),
    JSON.stringify({type:'ping'}),
  ];
  let i=0;
  const iv = setInterval(()=>{
    if(i>=msgs.length){clearInterval(iv); return;}
    const m = msgs[i++];
    ws.send(m);
    sent.push(m);
    console.log('  -> SEND', m.substring(0,200));
  }, 300);
});

ws.on('message', (data) => {
  const s = data.toString();
  recv.push(s);
  const ts = new Date().toISOString().substring(11,19);
  console.log(`[${ts}] <- RECV (${s.length}b):`, s.substring(0,600));
});

ws.on('pong', ()=>console.log('<- PONG'));

ws.on('error', (e)=>{ console.log('WS ERROR:', e.message); });

ws.on('close', (code, reason)=>{ console.log('WS CLOSED', code, reason.toString().substring(0,100)); });

// Ping keepalive
const pk = setInterval(()=>{ if(open){ try{ws.ping(); }catch(e){}} }, 15000);

setTimeout(()=>{
  clearInterval(pk);
  try{ws.close();}catch(e){}
  const allRecv = recv.join('\n');
  const interesting = recv.filter(m => {
    const l=m.toLowerCase();
    return l.includes('wingo') || l.includes('result') || l.includes('issue');
  });
  const out = {
    targetUrl: wsUrl,
    channel: channel,
    protocol: null,
    opened: open,
    sentMessages: sent,
    receivedCount: recv.length,
    receivedMessages: recv,
    interestingMessages: interesting,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets: [{
      url: wsUrl,
      protocol: null,
      opened: open,
      sentMessages: sent,
      receivedMessages: recv,
    }],
    winGoMessages: interesting,
  }, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log('Opened:', open);
  console.log('Sent messages:', sent.length);
  console.log('Received messages:', recv.length);
  console.log('Interesting (wingo/result/issue):', interesting.length);
  console.log('Saved detailed -> /tmp/wingo_ws_intercept_detailed.json');
  console.log('Saved intercept -> /tmp/wingo_ws_intercept.json');
}, 30000);
