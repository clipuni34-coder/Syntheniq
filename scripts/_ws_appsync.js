const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const u = new URL(loginData.data.webSocketUrl);
const HOST = u.hostname;
const PATH = u.pathname + u.search;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
const urlToken = u.searchParams.get('Token');
console.log('host:', HOST, '| channel:', channel);

function b64url(o){ return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function b64(s){ return Buffer.from(s).toString('base64url'); }

function maskPayload(dataBuf){
  const mask = Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out = Buffer.alloc(dataBuf.length);
  for(let i=0;i<dataBuf.length;i++) out[i]=dataBuf[i]^mask[i%4];
  return Buffer.concat([mask,out]);
}
function makeTextFrame(payload){
  const pb=Buffer.from(payload,'utf8'); const len=pb.length;
  let hdr;
  if(len<126){hdr=Buffer.alloc(2);hdr[0]=0x81;hdr[1]=len|0x80;}
  else if(len<65536){hdr=Buffer.alloc(4);hdr[0]=0x81;hdr[1]=0x7E|0x80;hdr.writeUInt16BE(len,2);}
  else {hdr=Buffer.alloc(10);hdr[0]=0x81;hdr[1]=0x7F|0x80;hdr.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([hdr, maskPayload(pb)]);
}

const sent=[], recv=[], events=[];
let opened=false, gotAck=false;
const projs = process.env.SUBS || 'aws-appsync-event-ws';
const authJwt = process.env.JWT || urlToken;
const authObj = (process.env.OBJ||'auth')==='both' ? {host:HOST, authorization:authJwt} : {authorization:authJwt};
const hdrSub = 'header-'+b64url(authObj);
const protocols = [projs, hdrSub];
console.log('subprotocols:', JSON.stringify(protocols));
console.log('authObj:', JSON.stringify(authObj).substring(0,120));

const HS = [
  'GET '+PATH+' HTTP/1.1',
  'Host: '+HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://h5.ar-lottery01.com',
  'Sec-WebSocket-Protocol: '+protocols.join(', '),
  '', ''
].join('\r\n');

const socket = tls.connect(443, HOST, {rejectUnauthorized:false, servername:HOST}, ()=>{ socket.write(HS); });
socket.setNoDelay(true);
let leftover=Buffer.alloc(0), headerDone=false;

function sendWsText(str){ socket.write(makeTextFrame(str)); sent.push(str); }
function uuid(){ return crypto.randomUUID(); }

socket.on('data',(chunk)=>{
  leftover=Buffer.concat([leftover,chunk]);
  if(!headerDone){
    const idx=leftover.indexOf('\r\n\r\n');
    if(idx<0) return;
    const hs=leftover.slice(0,idx).toString();
    const bodyStart=idx+4;
    headerDone=true;
    const m101 = hs.includes(' 101 ');
    const echoedProt = hs.toLowerCase().includes('sec-websocket-protocol:') ? hs.split('\r\n').find(l=>l.toLowerCase().startsWith('sec-websocket-protocol:')) : '(not echoed)';
    console.log('--- handshake status 101?', m101);
    console.log('   echoed proto:', echoedProt ? echoedProt.trim().substring(0,120) : '(none)');
    if(!m101){ console.log(hs.substring(0,400)); socket.end(); return; }
    console.log('*** WS OPEN ***');
    leftover=leftover.slice(bodyStart);
  }
  let off=0;
  while(off<leftover.length){
    if(off+2>leftover.length) break;
    const b0=leftover[off], b1=leftover[off+1];
    const opcode=b0&0x0F; let masked=(b1&0x80)!==0;
    let len=b1&0x7F, lf=2;
    if(len===126){ if(off+4>leftover.length) break; len=leftover.readUInt16BE(off+2); lf=4; }
    else if(len===127){ if(off+10>leftover.length) break; len=Number(leftover.readBigUInt64BE(BigInt(off+2))); lf=10; }
    if(off+lf+(masked?4:0)+len>leftover.length) break;
    let start=off+lf; let text;
    if(masked){ const mask=leftover.slice(start,start+4); const data=leftover.slice(start+4,start+4+len); for(let i=0;i<data.length;i++)data[i]^=mask[i%4]; text=data.toString('utf8'); start+=4; }
    else { text=leftover.slice(start,start+len).toString('utf8'); }
    if(opcode===0x9){ /* ping -> send pong */ const pong=makePong(); socket.write(pong); console.log('  -> PONG'); }
    else if(opcode===0xA){}
    else if(opcode===0x8){ console.log('  [CLOSE]', text.substring(0,100)); }
    else if(opcode===0x1){
      recv.push(text);
      console.log('  <- RECV:', text.substring(0,500));
      try{ const m=JSON.parse(text);
        if(m.type==='connection_ack') gotAck=true;
        if(m.type==='data'||m.type==='ka'||m.type==='subscribe_success'||m.type==='subscribe_error'||m.type==='connection_error') events.push(m);
      }catch(e){}
    }
    off=start+len;
  }
  leftover=leftover.slice(off);
});
function makePong(){ /* server ping is unmasked; pong must be masked, opcode 0xA */ return makeControlFrame(0xA, Buffer.alloc(0)); }
function makeControlFrame(opcode, payloadBuf){
  const mask=Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out=Buffer.alloc(payloadBuf.length); for(let i=0;i<payloadBuf.length;i++)out[i]=payloadBuf[i]^mask[i%4];
  const len=payloadBuf.length; const hdr=Buffer.alloc(2); hdr[0]=0x80|opcode; hdr[1]=len|0x80;
  return Buffer.concat([hdr,mask,out]);
}
socket.on('error',e=>console.log('socket err:',e.message));

setTimeout(()=>{
  if(opened){
    sendWsText(JSON.stringify({type:'connection_init'})); console.log('  -> SEND connection_init');
  }
  setTimeout(()=>{
    const sub={type:'subscribe', id:uuid(), channel:channel, authorization:authObj};
    sendWsText(JSON.stringify(sub)); console.log('  -> SEND subscribe:', JSON.stringify(sub).substring(0,200));
    // try WinGo channels too
    ['/WebApi/1004/lottery/WinGo_30S','/WebApi/1004/game/WinGo_30S','/Lottery/WinGo_30S'].forEach(c=>{
      sendWsText(JSON.stringify({type:'subscribe',id:uuid(),channel:c,authorization:authObj}));
    });
  }, 1200);
}, 300);

setTimeout(()=>{
  try{socket.end();}catch(e){}
  const interesting = recv.filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue')||l.includes('number');});
  const out={
    targetUrl:loginData.data.webSocketUrl, host:HOST, channel, subprotocols:protocols, authJwtUsed: authJwt.substring(0,40),
    opened, gotAck, sentMessages:sent, receivedCount:recv.length, receivedMessages:recv,
    interestingMessages:interesting, events,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets:[{url:loginData.data.webSocketUrl, protocol: protocols.join(','), opened, channel,
      subprotocols:protocols, sentMessages:sent, receivedMessages:recv}],
    winGoMessages:interesting,
  },null,2));
  console.log('\n=== SUMMARY ===');
  console.log('opened:', opened, '| connection_ack:', gotAck, '| sent:', sent.length, '| recv:', recv.length, '| interesting:', interesting.length);
  console.log('events types:', events.map(e=>e.type).join(','));
  process.exit(0);
}, 28000);
