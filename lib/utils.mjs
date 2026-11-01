export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function escapeJs(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function readBody(req, maxBytes = 1048576) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    let size = 0;

    // Reject a declared oversized body before attaching data handlers. This
    // avoids reading/allocating a request that the route can never accept and
    // applies uniformly to every JSON, webhook and harness endpoint using
    // readBody(). Transfer-Encoding: chunked requests still use the bounded
    // streaming check below.
    const rawLength = Array.isArray(req?.headers?.['content-length'])
      ? req.headers['content-length'][0]
      : req?.headers?.['content-length'];
    const declaredLength = Number.parseInt(rawLength || '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.destroy?.();
      reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
      return;
    }

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolvePromise(body));
    req.on('error', reject);
  });
}
