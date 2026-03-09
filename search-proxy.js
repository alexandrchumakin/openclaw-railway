// Lightweight web search proxy using DuckDuckGo HTML
// Provides Brave Search API-compatible endpoint for OpenClaw
const http = require('http');
const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function searchDDG(query, count = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetch(url);
  const results = [];
  const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < count) {
    const href = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    if (href.startsWith('http')) {
      results.push({ title, url: href, description: snippet });
    }
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/search')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const q = params.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing q parameter' }));
    }
    try {
      const results = await searchDDG(q, parseInt(params.get('count') || '5'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        web: { results: results.map(r => ({ title: r.title, url: r.url, description: r.description })) }
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(9876, '127.0.0.1', () => {
  console.log('Search proxy listening on http://127.0.0.1:9876');
});
