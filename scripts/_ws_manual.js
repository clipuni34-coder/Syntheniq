const tls = require('tls');
const fs = require('fs');
const Net = require('net');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const u = new URL(loginData.data.webSocketUrl);
const HOST = u.hostname;
const PATH = u.pathname + u.search;
const channel = (loginData.data.webSocketChannels||['/WebApi/1004/userid/364070'])[0];
const NUL = '\x00';

console.log('host:', HOST);
console.log('path:', PATH.substring(0,40)+'...');
console.log('channel:', channel);

// ---- WebSocket frame helpers ----
function maskPayload(dataBuf){
  const mask = Buffer.from([Math.random()*256|0, Math.random()*256|0, Math.random()*256|0, Math.random()*256|0]);
  const out = Buffer.alloc(dataBuf.length);
  for(let i=0;i<dataBuf.length;i++) out[i] = dataBuf[i] ^ mask[i%4];
  return Buffer.concat([mask, out]);
}
function makeTextFrame(payload){
  const payloadBuf = Buffer.from(payload, 'utf8');
  let headerSize = 2;
  if(payloadBuf.length > 65535) headerSize = 10;
  else if(payloadBuf.length > 125) headerSize = 4;
  const header = Buffer.alloc(headerSize);
  header[0] = 0x81; // FIN + text
  let len = payloadBuf.length;
  let maskLenField = 0x80; // mask bit set
  if(len < 126){ header[1] = len | 0x80; headerSize=2; }
  else if(len < 65536){ header[1]=0x7E | 0x80; header.writeUInt16BE(len,2); headerSize=4; }
  else { header[1]=0x7F | 0x80; header.writeBigUInt64BE(BigInt(len),2); headerSize=10; }
  return Buffer.concat([header, maskPayload(payloadBuf)]);
}
function parseFrames(buf){
  const frames=[]; let off=0;
  while(off < buf.length){
    if(off+2 > buf.length) break;
    const b0 = buf[off]; const b1 = buf[off+1];
    const fin = (b0 & 0x80)!==0; const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80)!==0;
    let len = b1 & 0x7F; let lenfield=2;
    if(len===126){ len = buf.readUInt16BE(off+2); lenfield+=2; }
    else if(len===127){ len = Number(buf.readBigUInt64BE(BigInt(off+2))); lenfield+=8; }
    if(off+lenfield+len > buf.length) break;
    let start = off+lenfield;
    if(masked){
      const mask = buf.slice(start, start+4);
      const data = buf.slice(start+4, start+4+len);
      for(let i=0;i<data.length;i++) data[i]^=mask[i%4];
      frames.push({fin,opcode,masked,text:data.toString('utf8'),binary:data});
    } else {
      const data = buf.slice(start, start+len);
      frames.push({fin,opcode,masked,text:data.toString('utf8'),binary:data});
    }
    off = start + (masked?4:0) + len;
  }
  return frames;
}

const sent=[], recv=[];
let opened=false, closed=false;
const handshake = [
  'GET '+PATH+' HTTP/1.1',
  'Host: '+HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://fb999.com',
  'Sec-WebSocket-Protocol: stomp',
  '', ''
].join('\r\n');

const socket = tls.connect(443, HOST, {rejectUnauthorized:false, servername:HOST}, ()=>{
  process.stdout.write('>> '+handshake.replace(/\r\n/g,'\\n')+'\n');
  socket.write(handshake);
});
socket.setNoDelay(true);

let leftover = Buffer.alloc(0);
let inFrames = [];
socket.on('data', (chunk)=>{
  // check if HTTP response (first time) or WS frames
  leftover = Buffer.concat([leftover, chunk]);
  if(!opened){
    const idx = leftover.indexOf('\r\n\r\n');
    if(idx>=0){
      const headerStr = leftover.slice(0,idx).toString();
      console.log('--- HTTP RESPONSE ---'); console.log(headerStr.substring(0,400));
      const bodyStart = idx+4;
      const is101 = headerStr.includes(' 101 ');
      if(!is101){ console.log('NOT 101 - aborting'); socket.end(); return; }
      opened = true;
      console.log('*** 101 Switching Protocols - WS OPEN ***');
      leftover = leftover.slice(bodyStart);
    } else { return; } // wait for full headers
  }
  if(leftover.length){
    const frames = parseFrames(leftover);
    let consumed=0;
    // recompute consumed by re-parsing? parseFrames stops at incomplete. We need bytes consumed.
    // Simpler: parseFrames returns frames; recompute consumed offset by walking.
    let off=0;
    while(off < leftover.length){
      if(off+2>leftover.length) break;
      const b1=leftover[off+1]; const masked=(b1&0x80)!==0; let len=b1&0x7F, lf=2;
      if(len===126){ len=leftover.readUInt16BE(off+2); lf+=2; }
      else if(len===127){ len=Number(leftover.readBigUInt64BE(BigInt(off+2))); lf+=8; }
      if(off+lf+len > leftover.length) break;
      // consume
      const frameBuf = leftover.slice(off, off+lf+ (masked?4:0) + len);
      const pf = parseFrames(frameBuf)[0];
      if(pf){
        if(pf.opcode===0x9){ /* ping -> send pong */ 
          const pong = makeFrame(0x8A, pf.binary);
          socket.write(pong); console.log('  -> PONG (reply to ping)');
        } else if(pf.opcode===0x8){
          console.log('  [CLOSE frame]'); closed=true;
        } else if(pf.opcode===0x1){
          const s=pf.text; recv.push(s);
          const ts=new Date().toISOString().substring(11,19);
          console.log(`[${ts}] <- RECV (${s.length}b):`);
          process.stdout.write(s.substring(0,700)+'\n');
        }
      }
      off += lf + (masked?4:0) + len;
    }
    leftover = leftover.slice(off);
  }
});
socket.on('error', e=>{ if(!closed) console.log('socket err:', e.message); });

function makeControlFrame(opcode, payloadBuf){
  // unmasked server->client style not needed for client; for PONG mask it
  const mask = Buffer.from([0,0,0,0]);
  const len = payloadBuf.length;
  const hdr = Buffer.alloc(len>125?4:2);
  hdr[0] = 0x80 | opcode;
  let sz=2;
  if(len<126){ hdr[1]=len|0x80; }
  else if(len<65536){ hdr[1]=0x7E|0x80; hdr.writeUInt16BE(len,2); sz=4; }
  else { hdr[1]=0x7F|0x80; hdr.writeBigUInt64BE(BigInt(len),2); sz=10; }
  return Buffer.concat([hdr, maskPayload(payloadBuf)]);
}
function makeFrame(opcode, payloadBuf){
  const mask = Buffer.from([Math.random()*256|0,Math.random()*256|0,Math.random()*256|0,Math.random()*256|0]);
  const out = Buffer.alloc(payloadBuf.length);
  for(let i=0;i<payloadBuf.length;i++) out[i]=payloadBuf[i]^mask[i%4];
  const len = payloadBuf.length;
  let hdr;
  if(len<126){ hdr=Buffer.alloc(2); hdr[0]=0x80|opcode; hdr[1]=len|0x80; }
  else if(len<65536){ hdr=Buffer.alloc(4); hdr[0]=0x80|opcode; hdr[1]=0x7E|0x80; hdr.writeUInt16BE(len,2); }
  else { hdr=Buffer.alloc(10); hdr[0]=0x80|opcode; hdr[1]=0x7F|0x80; hdr.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([hdr, mask, out]);
}

function sendText(str){
  socket.write(makeTextFrame(str));
  sent.push(str);
}

setTimeout(()=>{
  if(opened){
    sendText('CONNECT\naccept-version:1.2\nhost:'+HOST+'\n\n'+NUL);
    console.log('  -> SEND CONNECT');
  }
}, 400);
setTimeout(()=>{
  if(opened){
    sendText('SUBSCRIBE\ndestination:'+channel+'\nid:1\nack:auto\n\n'+NUL);
    console.log('  -> SEND SUBSCRIBE', channel);
    setTimeout(()=>{
      ['/WebApi/1004/lottery/WinGo_30S','/WebApi/1004/game/WinGo_30S','/Lottery/WinGo_30S','/WebApi/1004/userid/364070','/topic/WinGo_30S'].forEach((c,i)=>{
        sendText('SUBSCRIBE\ndestination:'+c+'\nid:'+String(i+2)+'\nack:auto\n\n'+NUL);
      });
      console.log('  -> sent extra subscriptions');
    },1500);
  }
}, 1200);

setTimeout(()=>{
  try{ socket.end(); }catch(e){}
  const interesting = recv.filter(m=>{const l=m.toLowerCase();return l.includes('wingo')||l.includes('result')||l.includes('issue');});
  const out = {
    targetUrl: loginData.data.webSocketUrl,
    host: HOST, path: PATH, protocol:'stomp',
    channel: channel, opened,
    sentMessages: sent, receivedCount: recv.length, receivedMessages: recv,
    interestingMessages: interesting,
  };
  fs.writeFileSync('/tmp/wingo_ws_intercept_detailed.json', JSON.stringify(out,null,2));
  fs.writeFileSync('/tmp/wingo_ws_intercept.json', JSON.stringify({
    originalWebSockets:[{url:loginData.data.webSocketUrl, protocol:'stomp', opened, channel, sentMessages:sent, receivedMessages:recv}],
    winGoMessages: interesting,
  },null,2));
  console.log('\n=== SUMMARY ===');
  console.log('Opened:', opened, 'Connected(101):', opened);
  console.log('Sent frames:', sent.length, 'Received frames:', recv.length, 'Interesting:', interesting.length);
  process.exit(0);
}, 30000);
