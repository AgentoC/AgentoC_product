export function appendQueryMarker(value, key, marker) {
  const input = String(value || '').trim();
  const normalizedKey = String(key || '').trim();
  const normalizedMarker = String(marker || '').trim();
  if (!input) return '';
  if (!normalizedKey) return input;

  const isAbsolute = /^https?:\/\//i.test(input);
  const url = new URL(isAbsolute ? input : input.startsWith('/') ? input : `/${input}`, 'http://placeholder.invalid');
  url.searchParams.set(normalizedKey, normalizedMarker);

  if (isAbsolute) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseCloudflareTrace(body) {
  const result = {};
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

export function median(values) {
  const numbers = (values || []).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middleIndex = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 1) return numbers[middleIndex];
  return (numbers[middleIndex - 1] + numbers[middleIndex]) / 2;
}

function matchField(text, expression) {
  const match = expression.exec(text);
  return match?.[1]?.trim() || null;
}

export function parseCloudflaredTunnelInfo(output) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/);
  const connectors = [];
  let inConnectorTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!inConnectorTable) {
      if (/^CONNECTOR ID\s+/.test(line)) {
        inConnectorTable = true;
      }
      continue;
    }

    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 6) continue;
    connectors.push({
      connectorId: parts[0],
      created: parts[1],
      architecture: parts[2],
      version: parts[3],
      originIp: parts[4],
      edge: parts.slice(5).join(' '),
    });
  }

  return {
    name: matchField(text, /^NAME:\s+(.+)$/m),
    id: matchField(text, /^ID:\s+(.+)$/m),
    created: matchField(text, /^CREATED:\s+(.+)$/m),
    connectors,
  };
}

