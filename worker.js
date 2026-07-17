/**
 * CORS proxy for the Tickets Assignment Tracker (Zendesk + Slack).
 *
 * Neither Zendesk's nor Slack's Web API sends CORS headers, so a browser calling
 * them directly from a static page (GitHub Pages, Firebase Hosting, etc.) gets
 * blocked. This worker sits in front of both, forwards the request, and adds the
 * CORS headers back onto the response.
 *
 * Deploy (Cloudflare dashboard):
 *   1. workers.cloudflare.com -> Create Application -> Create Worker
 *   2. Paste this file's contents into the editor, replacing the template
 *   3. Deploy, copy the workers.dev URL it gives you
 *   4. Paste that URL into admin.html's "Cloudflare Proxy URL" field (used for both
 *      the Zendesk API and Slack sections)
 *
 * Deploy (wrangler CLI):
 *   npx wrangler deploy worker.js
 *
 * Request contract:
 *   GET/POST/PUT/PATCH/DELETE {workerUrl}?target=<url-encoded full API URL>
 *   Authorization header is forwarded through untouched (Zendesk Basic Auth token,
 *   or Slack "Bearer <bot token>").
 *   Only requests targeting *.zendesk.com or slack.com are forwarded.
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const requestUrl = new URL(request.url);
        const target = requestUrl.searchParams.get('target');

        if (!target) {
            return jsonError('Missing "target" query parameter.', 400);
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch (e) {
            return jsonError('Invalid "target" URL.', 400);
        }

        if (!isAllowedHost(targetUrl.hostname)) {
            return jsonError('This proxy only forwards requests to *.zendesk.com or slack.com.', 403);
        }

        const forwardHeaders = new Headers();
        const auth = request.headers.get('Authorization');
        if (auth) forwardHeaders.set('Authorization', auth);
        const contentType = request.headers.get('Content-Type');
        if (contentType) forwardHeaders.set('Content-Type', contentType);

        const init = { method: request.method, headers: forwardHeaders };
        if (!['GET', 'HEAD'].includes(request.method)) {
            init.body = await request.text();
        }

        const zendeskResponse = await fetch(targetUrl.toString(), init);
        const responseBody = await zendeskResponse.text();

        return new Response(responseBody, {
            status: zendeskResponse.status,
            headers: {
                'Content-Type': zendeskResponse.headers.get('Content-Type') || 'application/json',
                ...CORS_HEADERS,
            },
        });
    },
};

function isAllowedHost(hostname) {
    return hostname.endsWith('.zendesk.com') || hostname === 'slack.com';
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}
