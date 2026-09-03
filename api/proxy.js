// api/proxy.js
// Proxies HLS manifests (.m3u8) and their segments/keys so the browser never
// hits CORS, mixed-content, or missing-Referer blocks directly.
//
// - Forwards a realistic User-Agent / Referer / Origin upstream
// - Follows redirects
// - Times out dead streams instead of hanging forever
// - Rewrites every URI inside a manifest (segments, keys, nested playlists)
//   to also route back through this proxy, so playback never leaves the proxy

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawUrl = req.query.url;
  const rawReferer = req.query.referer;

  if (!rawUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(Array.isArray(rawUrl) ? rawUrl[0] : rawUrl);
    // eslint-disable-next-line no-new
    new URL(targetUrl);
  } catch (e) {
    res.status(400).json({ error: 'Invalid url parameter' });
    return;
  }

  const referer = rawReferer
    ? decodeURIComponent(Array.isArray(rawReferer) ? rawReferer[0] : rawReferer)
    : `${new URL(targetUrl).protocol}//${new URL(targetUrl).host}/`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Origin: referer.replace(/\/$/, ''),
        Accept: '*/*',
      },
    });

    clearTimeout(timer);

    if (!upstream.ok) {
      res
        .status(upstream.status)
        .json({ error: `Upstream returned ${upstream.status}`, url: targetUrl });
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const looksLikeManifest =
      targetUrl.toLowerCase().split('?')[0].endsWith('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('vnd.apple.mpegurl');

    if (looksLikeManifest) {
      const text = await upstream.text();
      // upstream.url reflects the final URL after redirects, which is the
      // correct base for resolving relative segment paths
      const finalUrl = upstream.url || targetUrl;
      const rewritten = rewriteManifest(text, finalUrl, referer);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.status(200).send(rewritten);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(200).send(buffer);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'Upstream stream timed out', url: targetUrl });
    } else {
      res.status(502).json({ error: `Proxy fetch failed: ${err.message}`, url: targetUrl });
    }
  }
};

function proxify(absoluteUrl, referer) {
  return `/api/proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(
    referer
  )}`;
}

function rewriteManifest(text, baseUrl, referer) {
  const base = new URL(baseUrl);

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();

      // Encryption key / init-segment map lines carry a URI="..." attribute
      if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP')) {
        return line.replace(/URI="([^"]+)"/, (_match, uri) => {
          const resolved = new URL(uri, base).toString();
          return `URI="${proxify(resolved, referer)}"`;
        });
      }

      // Comments / tags with no URI payload pass through untouched
      if (!trimmed || trimmed.startsWith('#')) {
        return line;
      }

      // Everything else is a segment or nested-playlist URI
      const resolved = new URL(trimmed, base).toString();
      return proxify(resolved, referer);
    })
    .join('\n');
}
