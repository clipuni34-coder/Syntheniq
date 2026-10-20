const tls = require('tls');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const u = new URL(loginData.data.webSocketUrl);
const HOST = u.hostname;
const REQ = [
  'GET '+u.pathname+u.search+' HTTP/1.1',
  'Host: '+HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Origin: https://fb999.com',
  'Sec-WebSocket-Protocol: stomp',
  '', ''
].join('\r\n');
console.log('Connecting to', HOST, '...');
const socket = tls.connect(443, HOST, {rejectUnauthorized:false, servername:HOST}, ()=>{
  console.log('TLS connected, sending upgrade:');
  socket.write(REQ);
  console.log('--- request sent ---');
});
socket.setEncoding('utf8');
socket.on('data', (d)=>{ console.log('--- RESPONSE ---'); console.log(d.substring(0,600)); socket.end(); });
socket.on('error', (e)=>console.log('socket err:', e.message));
setTimeout(()=>{ console.log('(timeout, no response)'); socket.end(); process.exit(0); }, 8000);
