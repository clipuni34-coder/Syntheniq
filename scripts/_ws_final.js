const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const u = new URL(loginData.data.webSocketUrl);
const HOST = u.hostname;
const PATH = u.pathname + u.search;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
const urlToken = u.searchParams.get('Token');
const DURATION = Number(process.env.DUR||35000);

function b64url(o){ return Buffer.from(JSON.stringify(o)).toString('base64url'); }
const authObj = {host:HOST, authorization:urlToken};
const hdrSub = 'header-'+b64url(authObj);
const protocols = ['aws-appsync-event-ws', hdrSub];

function maskPayload(dataBuf){
  const mask=Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out=Buffer.alloc(dataBuf.length);
  for(let i=0;i<dataBuf.length;i++) out[i]=dataBuf[i]^mask[i%4];
  return Buffer.concat([mask,out]);
}
function makeTextFrame(payload){
  const pb=Buffer.from(payload,'utf8'); const len=pb.length; let hdr;
  if(len<126){hdr=Buffer.alloc(2);hdr[0]=0x81;hdr[1]=len|0x0x80??0|0x80;} // fix below
  return Buffer.from('fix','utf8'); // placeholder to satisfy parse; rebuilt properly below
}
// rebuild cleanly:
function textFrame(payload){
  const pb=Buffer.from(payload,'utf8'); const len=pb.length; let hdr;
  if(len<126){hdr=Buffer.alloc(2);hdr[0]=0x81;hdr[1]=len|0x80;}
  else if(len<65536){hdr=Buffer.alloc(4);hdr[0]=0x81;hdr[1]=0x7E|0x80;hdr.writeUInt16BE(len,2);}
  else {hdr=Buffer.alloc(10);hdr[0]=0x81;hdr[1]=0x7F|0x80;hdr.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([hdr, maskPayload(pb)]);
}

const sent=[], recv=[];
let opened=false, ackReceived=false;
const HS = ['GET '+PATH+' HTTP/1.1','Host: '+HOST,'Connection: Upgrade','Upgrade: websocket',
  'Sec-WebSocket-Version: 13','Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://h5.ar-lottery01.com','Sec-WebSocket-Protocol: '+protocols.join(', '),'',''].join('\r\n');

const socket = tls.connect(443, HOST, {rejectUnauthorized:false, servername:HOST}, ()=>{ socket.write(HS); });
socket.setNoDelay(true);
let leftover=Buffer.alloc(0), headerDone=false;

function parseFrames(buf){
  const frames=[]; let off=0;
  while(off<buf.length){
    if(off+2>buf.length) break;
    const b0=buf[off], b1=buf[off+1]; const opcode=b0&0x0F; const masked=(b1&0x80)!==0;
    let len=b1&0x7F, lf=2;
    if(len===126){ if(off+4>buf.length) break; len=buf.readUInt16BE(off+2); lf=4; }
    else if(len===127){ if(off+10>buf.length) break; len=Number(buf.readBigUInt64BE(BigInt(off+2))); lf=10; }
    if(off+lf+(masked?4:0)+len>buf.length) break;
    let start=off+lf; let data;
    if(masked){ const m=buf.slice(start,start+4); data=buf.slice(start+4,start+4+len); for(let i=0;i<data.length;i++) data[i]^=m[i%4]; start+=4; }
    else { data=buf.slice(start,start+len); }
    frames.push({opcode,masked,text:data.toString('utf8'),byteLen:len,start:off,len:lf+(masked?4:0)+len});
    off=start+len;
  }
  return frames;
}
function controlFrame(opcode, payloadBuf){
  const mask=Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out=Buffer.alloc(payloadBuf.length); for(let i=0;i<payloadBuf.length;i++) out[i]=payloadBuf[i]^mask[i%4];
  const len=payloadBuf.length; const hdr=Buffer.alloc(2); hdr[0]=0x80|opcode; hdr[1]=len|0x80;
  return Buffer.concat([hdr,mask,out]);
}
function sendText(s){ socket.write(textFrame(s)); sent.push(s); console.log('  -> SEND:', s.substring(0,120)); }

socket.on('data',(chunk)=>{
  leftover=Buffer.concat([leftover,chunk]);
  if(!headerDone){
    const idx=leftover.indexOf('\r\n\r\n');
    if(idx<0) return;
    const hs=leftover.slice(0,idx).toString(); headerDone=true;
    if(!hs.includes(' 101 ')){ console.log('HANDSHAKE FAIL:\n'+hs.substring(0,300)); socket.end(); return; }
    const echoed = hs.split('\r\n').find(l=>l.toLowerCase().startsWith('sec-websocket-protocol'));
    console.log('*** 101 OK | echoed:', echoed?echoed.trim():'(none)');
    opened=true;
    leftover=leftover.slice(idx+4);
  }
  const frames=parseFrames(leftover);
  let consumed=0, lastOff=0;
  for(const f of frames){
    lastOff = f.start + f.len;
    if(f.opcode===0x9){ socket.write(controlFrame(0xA, Buffer.alloc(0))); console.log('  -> PONG'); }
    else if(f.opcode===0x8){ console.log('  [CLOSE]', f.text.substring(0,80)); }
    else if(f.opcode===0x1){
      recv.push(f.text);
      const ts=new Date().toISOString().substring(11,19);
      console.log(`[${ts}] <- RECV:`, f.text.substring(0,700));
      try{ const m=JSON.parse(f.text); if(m.type==='connection_ack') ackReceived=true; }catch(e){}
    }
  }
  // consume processed bytes up to lastOff
  if(frames.length){ leftover=leftover.slice(lastOff); }
});
socket.on('error',e=>console.log('socket err:',e.message));

setTimeout(()=>{
  if(opened){
    sendText(JSON.stringify({type:'connection_init'}));
    setTimeout(()=>{
      sendText(JSON.stringify({type:'subscribe', id:crypto.randomUUID(), channel:channel, authorization:authObj}));
    }, 300);
    const pk=setInterval(()=>{ try{socket.write(textFrame(JSON.stringify({type:'pong'})));}catch(e){} }, 20000);
  }
}, 300);

setTimeout(()=>{
  const interesting = recv.filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue')||l.includes('number');});
  const out={
    targetUrl: loginData.data.webSocketUrl, host: HOST, channel,
    subprotocols: protocols, authJwtUsed: urlToken.substring(0,40),
    opened, ackReceived, connection_ack_sent:false,
    sentMessages: sent, receivedCount: recv.length, receivedMessages: recv,
    interestingMessages: interesting,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets:[{url:loginData.data.webSocketUrl, protocol:'aws-appsync-event-ws', opened, channel,
      subprotocols:protocols, sentMessages:sent, receivedMessages:recv}],
    winGoMessages: interesting,
  },null,2));
  console.log('\n=== SUMMARY ===');
  console.log('opened:', opened, '| connection_ack:', ackReceived, '| sent:', sent.length, '| received:', recv.length, '| interesting:', interesting.length);
  try{socket.end();}catch(e){}
  process.exit(0);
}, DURATION);
console.log('Capturing', DURATION/1000,'s on', channel);
