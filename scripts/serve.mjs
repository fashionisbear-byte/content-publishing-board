import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.env.PORT || 4173);
createServer(async (request, response) => {
  if (!['/', '/index.html', '/tiktok-board/', '/tiktok-board/index.html'].includes(request.url?.split('?')[0])) { response.writeHead(404); response.end('Not found'); return; }
  try { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(await readFile('index.html')); }
  catch { response.writeHead(500); response.end('Run npm run build first'); }
}).listen(port, '127.0.0.1', () => console.log(`本地预览：http://127.0.0.1:${port}/`));
