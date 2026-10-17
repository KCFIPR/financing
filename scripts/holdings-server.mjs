import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createEditorStore } from './editor-store.mjs';
import { createFundLookup } from './fund-lookup.mjs';
import { editorApiVersion } from './editor-core.mjs';

export async function startHoldingsServer({root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=8765,lookupFund=createFundLookup()} = {}) {
  const store = createEditorStore(root);
  await store.initialize();
  const server = http.createServer(async (req,res) => {
    const json = (status,body) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    const address = server.address();
    const hosts = [`127.0.0.1:${address.port}`,`localhost:${address.port}`];
    if (!hosts.includes(req.headers.host)) return json(403,{error:'请通过本机地址访问'});
    if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return json(403,{error:'不允许来自其他网站的请求'});
    try {
      const url = new URL(req.url,`http://${req.headers.host}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/持仓填写.html')) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'});
        return res.end(await fs.readFile(path.join(root,'持仓填写.html')));
      }
      if (req.method === 'GET' && pathname === '/api/holdings') return json(200,await store.load());
      if (pathname === '/api/fund') {
        if (req.method !== 'GET') return json(405,{error:'不支持此请求方式'});
        const code = url.searchParams.get('code');
        if (!/^\d{6}$/.test(code || '')) return json(400,{error:'基金代码须为六位数字'});
        return json(200,await lookupFund(code));
      }
      if (req.method === 'PUT' && pathname === '/api/holdings') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'保存内容须为JSON'});
        let size=0; const chunks=[];
        for await (const chunk of req) {size+=chunk.length;if(size>2*1024*1024) return json(413,{error:'文件超过2MB'});chunks.push(chunk);}
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.api_version !== editorApiVersion()) return json(409,{error:'页面与持仓服务版本不一致，请刷新页面；若仍不一致，请重启持仓服务'});
        return json(200,await store.save(request.document,request.revision,request.mode));
      }
      if (pathname === '/api/holdings') return json(405,{error:'不支持此请求方式'});
      return json(404,{error:'页面不存在'});
    } catch(error) {json(error.status || 400,{error:error.code ? `读写失败（${error.code}），请检查JSON及目录权限` : error.message});}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHoldingsServer().then(server => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`持仓填写页面：${url}\n数据文件：每日持仓.json\n关闭此窗口或按 Ctrl+C 停止服务。`);
    if (process.argv.includes('--open') && process.platform === 'win32') execFile('rundll32.exe',['url.dll,FileProtocolHandler',url],error => {if(error)console.error('请手动在浏览器打开上述地址。');});
  }).catch(error => {console.error(error.code === 'EADDRINUSE' ? '端口8765已在使用；如果持仓服务已启动，请打开 http://127.0.0.1:8765 。' : error.message);process.exitCode=1;});
}
