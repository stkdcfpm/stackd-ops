// Stackd Ops — Cloudflare Worker CORS proxy for Google Apps Script
//
// Deploy on workers.cloudflare.com (free tier).
// After deploying, copy your worker URL and paste the full endpoint into
// Stackd Ops Settings → Endpoint URL:
//
//   https://your-worker.workers.dev/macros/s/YOUR_DEPLOYMENT_ID/exec
//
// The worker forwards the POST body to Google Apps Script and adds the CORS
// headers the browser requires. No auth, no secrets — the sync token is
// carried in the POST body by the portal.

// Only forward to valid Apps Script deployment paths — prevents use as an open proxy
const VALID_PATH = /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    if (!VALID_PATH.test(url.pathname)) {
      return new Response('Forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    const target = 'https://script.google.com' + url.pathname + url.search;

    const response = await fetch(target, {
      method: request.method,
      headers: { 'Content-Type': 'text/plain' },
      body: request.method === 'POST' ? await request.text() : undefined,
      redirect: 'follow'
    });

    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }
};
