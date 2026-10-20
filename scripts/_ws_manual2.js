const tls = require('tls');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const u = new URL(loginData.data.webSocketUrl);
const HOST = u.hostname;
const PATH = u.pathname + u.search;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
const token = loginData.data.token;
console.log('host:', HOST, '| channel:', channel);

// ---- WS frame helpers ----
function maskPayload(dataBuf){
  const mask = Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out = Buffer.alloc(dataBuf.length);
  for(let i=0;i<dataBuf.length;i++) out[i]=dataBuf[i]^mask[i%4];
  return Buffer.concat([mask,out]);
}
function makeTextFrame(payload){
  const payloadBuf = Buffer.from(payload,'utf8');
  const len = payloadBuf.length;
  let hdr;
  if(len<126){ hdr=Buffer.alloc(2); hdr[0]=0x81; hdr[1]=len|0x80; }
  else if(len<65536){ hdr=Buffer.alloc(4); hdr[0]=0x81; hdr[1]=0x7E|0x80; hdr.writeUInt16BE(len,2);}
  else { hdr=Buffer.alloc(10); hdr[0]=0x81; hdr[1]=0x7F|0x80; hdr.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([hdr, maskPayload(payloadBuf)]);
}
const sent=[], recv=[];
let opened=false;
const NOSUB = !process.env.SUB; // default no sub-protocol
const protoLine = process.env.SUB ? ('Sec-WebSocket-Protocol: '+process.env.SUB) : '';
const handshake = [
  'GET '+PATH+' HTTP/1.1',
  'Host: '+HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://fb999.com',
  protoLine,
  '', ''
].filter(x=>x!=undefined && x.length>0 || x==='').join('\r\n');
// build handshake ignoring empty
const handshakeLines = [
  'GET '+PATH+' HTTP/1.1',
  'Host: '+HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://fb999.com',
].concat(process.env.SUB?['Sec-WebSocket-Protocol: '+process.env.SUB]:[]).concat(['','']);
const HS = handshakeLines.join('\r\n');

const socket = tls.connect(443, HOST, {rejectUnauthorized:false, servername:HOST}, ()=>{
  socket.write(HS);
});
socket.setNoDelay(true);
let leftover=Buffer.alloc(0), headerDone=false;
socket.on('data',(chunk)=>{
  leftover=Buffer.concat([leftover,chunk]);
  if(!headerDone){
    const idx=leftover.indexOf('\r\n\r\n');
    if(idx<0) return;
    const headerStr=leftover.slice(0,idx).toString();
    const bodyStart=idx+4;
    console.log('--- HTTP RESPONSE (first 300) ---'); console.log(headerStr.substring(0,300));
    if(!headerStr.includes(' 101 ')){ console.log('NOT 101; abort'); socket.end(); return; }
    const echoed = headerStr.toLowerCase().includes('sec-websocket-protocol');
    console.log('Server echoed WS protocol:', echoed);
    headerDone=true; opened=true;
    console.log('*** WS OPEN ***');
    leftover=leftover.slice(bodyStart);
  }
  // parse frames
  let off=0;
  while(off<leftover.length){
    if(off+2>leftover.length) break;
    const b0=leftover[off], b1=leftover[off+1];
    const opcode=b0&0x0F, masked=(b1&0x80)!==0;
    let len=b1&0x7F, lf=2;
    if(len===126){ if(off+4>leftover.length) break; len=leftover.readUInt16BE(off+2); lf=4; }
    else if(len===127){ if(off+10>leftover.length) break; len=Number(leftover.readBigUInt64BE(BigInt(off+2))); lf=10; }
    if(off+lf+(masked?4:0)+len>leftover.length) break;
    let start=off+lf;
    let text;
    if(masked){ const mask=leftover.slice(start,start+4); const data=leftover.slice(start+4,start+4+len); for(let i=0;i<data.length;i++) data[i]^=mask[i%4]; text=data.toString('utf8'); start+=4; }
    else { text=leftover.slice(start,start+len).toString('utf8'); }
    const fstart=off; const consumed=(start-off)+ (masked?0:0) - (masked?0:0);
    if(opcode===0x9){ /* ping -> pong not masked here, send unmasked close? just ignore, send pong */ }
    else if(opcode===0x8){ console.log('  [CLOSE frame] reason:', text.substring(0,100)); }
    else if(opcode===0x1){ recv.push(text); const ts=new Date().toISOString().substring(11,19); console.log(`[${ts}] <- RECV (${text.length}b):`); process.stdout.write(text.substring(0,800)+'\n'); }
    off = start + len;
  }
  leftover=leftover.slice(off);
});
socket.on('error',e=>console.log('socket err:',e.message));

function sendText(str){
  socket.write(makeTextFrame(str));
  sent.push(str);
}
function subMsg(o){ return JSON.stringify(o); }

const SUBS = [
  subMsg({type:'subscribe',channel}),
  subMsg({type:'subscribe',topic:channel}),
  subMsg({type:'subscribe',destination:channel}),
  subMsg({type:'sub',channel:channel}),
  subMsg({type:'join',channel}),
  subMsg({action:'subscribe',channel}),
  subMsg({subscribe:channel}),
  subMsg({type:'subscribe',channel,token:token}),
  subMsg({type:'auth',token:token}),
  subMsg({type:'init',token:token}),
  subMsg({type:'login',token:token,userId:'364070'}),
  subMsg({type:'subscribe',channel:'/WebApi/1004/lottery/WinGo_30S'}),
  subMsg({type:'subscribe',channel:'/WebApi/1004/game/WinGo_30S'}),
];

setTimeout(()=>{
  if(opened){
    let i=0;
    const iv=setInterval(()=>{
      if(i>=SUBS.length){clearInterval(iv); return;}
      const m=SUBS[i++]; sendText(m); console.log('  -> SEND', m.substring(0,160));
    },400);
    const pk=setInterval(()=>{ try{socket.write(makeTextFrame('{"type":"heartbeat"}'));}catch(e){} },10000);
  }
}, 500);

const DURATION = Number(process.env.DUR||30000);
setTimeout(()=>{
  const interesting = recv.filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue');});
  const out={
    targetUrl:loginData.data.webSocketUrl, host:HOST, path:PATH,
    subProtocol: process.env.SUB||'(none)', channel, opened,
    sentMessages:sent, receivedCount:recv.length, receivedMessages:recv,
    interestingMessages:interesting,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets:[{url:loginData.data.webSocketUrl, protocol:process.env.SUB||'(none)', opened, channel,
      sentMessages:sent, receivedMessages:recv}],
    winGoMessages:interesting,
  },null,2));
  console.log('\n=== SUMMARY ===');
  console.log('subProtocol:', process.env.SUB||'(none)', '| opened:', opened, '| sent:', sent.length, '| recv:', recv.length, '| interesting:', interesting.length);
  process.exit(0);
}, DURATION);
