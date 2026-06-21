const http = require('http');
const noProxyAgent = new http.Agent({ keepAlive: false });
['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].forEach(k=>delete process.env[k]);

function req(method, path, data={}, token=null) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const opt = { hostname:'127.0.0.1', port:3001, path, method, agent:noProxyAgent,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} };
    if (token) opt.headers['Authorization']='Bearer '+token;
    const r = http.request(opt, resp => {
      let d=''; resp.on('data',c=>d+=c);
      resp.on('end',()=>{try{res(JSON.parse(d))}catch(e){res({raw:d})}});
    });
    r.on('error', rej); r.write(body); r.end();
  });
}
module.exports = { req };
