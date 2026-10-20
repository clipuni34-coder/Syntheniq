const fs = require('fs');
const https = require('https');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const wsUrl = new URL(loginData.data.webSocketUrl);
const token = wsUrl.searchParams.get('Token');
console.log('host:', wsUrl.hostname, 'path:', wsUrl.pathname+wsUrl.search);

function hand(opts){
  const headers = {
    'Connection':'Upgrade',
    'Upgrade':'websocket',
    'Sec-WebSocket-Version':'13',
    'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==',
    'Host': wsUrl.hostname,
  };
  Object.assign(headers, opts);
  return new Promise((resolve)=>{
    const req = https.request({hostname:wsUrl.hostname, path:wsUrl.pathname+wsUrl.search, method:'GET', headers:headers, rejectUnauthorized:false}, (res)=>{
      let body=''; res.on('data',d=>body+=d); res.on('end',()=>{
        resolve({status:res.statusCode, headers:res.headers, body:body.substring(0,300)});
      });
    });
    req.on('error',e=>resolve({error:e.message}));
    req.end();
  });
}

(async()=>{
  console.log('\n=== Plain upgrade, no Origin ===');
  console.log(await hand({}));
  console.log('\n=== + Origin fb999.com ===');
  console.log(await hand({'Origin':'https://fb999.com'}));
  console.log('\n=== + Origin + Sec-WebSocket-Protocol: websocket ===');
  console.log(await hand({'Origin':'https://fb999.com','Sec-WebSocket-Protocol':'websocket'}));
  console.log('\n=== + Origin + Protocol: stomp (common for SockJS/STOMP) ===');
  console.log(await hand({'Origin':'https://h5.ar-lottery01.com','Sec-WebSocket-Protocol':'stomp'}));
})();
