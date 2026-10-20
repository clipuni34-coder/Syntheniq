const https = require('https');
const fs = require('fs');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json','utf8'));
const wsUrl = new URL(loginData.data.webSocketUrl);
const pathAndSearch = wsUrl.pathname + wsUrl.search;
const HOST = wsUrl.hostname;

function hand(extra){
  return new Promise((resolve)=>{
    const headers = {
      'Connection':'Upgrade','Upgrade':'websocket',
      'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==',
      'Host':HOST,
    };
    Object.assign(headers, extra);
    const req = https.request({hostname:HOST, path:pathAndSearch, method:'GET', headers, rejectUnauthorized:false}, (res)=>{
      let body=''; res.on('data',d=>body+=d);
      res.on('end',()=>resolve({status:res.statusCode, upgrade:res.headers.upgrade, connection:res.headers.connection, secProto:res.headers['sec-websocket-protocol'], server:res.headers.server, body:body.substring(0,200)}));
    });
    req.setTimeout(8000, ()=>{ req.destroy(new Error('timeout')); resolve({timeout:true}); });
    req.on('error',e=>resolve({error:e.message}));
    req.end();
  });
}
(async()=>{
  const tests=[
    {label:'no origin', extra:{}},
    {label:'Origin fb999.com', extra:{Origin:'https://fb999.com'}},
    {label:'Origin + proto stomp', extra:{Origin:'https://h5.ar-lottery01.com','Sec-WebSocket-Protocol':'stomp'}},
    {label:'proto v13', extra:{Origin:'https://fb999.com','Sec-WebSocket-Protocol':'v13'}},
  ];
  for(const t of tests){
    console.log('\n=== '+t.label+' ===');
    console.log(JSON.stringify(await hand(t.extra)));
  }
  console.log('\ntoken exp:', new Date(loginData.data.webSocketTokenExpireAt).toISOString());
})();
