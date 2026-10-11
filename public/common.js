export const PROTOCOL_VERSION = 1;

export function signaling(onMessage) {
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
  const queue = [];
  ws.onopen = () => queue.splice(0).forEach(m => ws.send(m));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  return {
    ws,
    send(msg) {
      const s = JSON.stringify(msg);
      ws.readyState === 1 ? ws.send(s) : queue.push(s);
    },
  };
}

export async function iceConfig({ directOnly = false } = {}) {
  let servers = await (await fetch('/ice')).json();
  if (directOnly) {
    servers = servers
      .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/^turns?:/.test(u)) }))
      .filter(s => s.urls.length);
  }
  const relayOnly = new URLSearchParams(location.search).has('relay');
  return { iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all' };
}

export async function connectionInfo(pc, prev = {}) {
  const stats = await pc.getStats();
  const byId = new Map();
  stats.forEach(s => byId.set(s.id, s));
  let pair = null;
  stats.forEach(s => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
  });
  if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  const local = pair && byId.get(pair.localCandidateId);
  const remote = pair && byId.get(pair.remoteCandidateId);
  const out = {
    route: local ? (local.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct') : '-',
    localType: local?.candidateType,
    remoteType: remote?.candidateType,
    protocol: local ? (local.candidateType === 'relay' ? `${local.relayProtocol || '?'} to TURN` : local.protocol) : '-',
    rtt: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    ts: performance.now(),
  };
  stats.forEach(s => {
    if (s.kind !== 'video') return;
    if (s.type === 'inbound-rtp') {
      out.fps = s.framesPerSecond;
      out.bytes = s.bytesReceived;
      out.lost = s.packetsLost;
      out.packets = s.packetsReceived;
      out.res = s.frameWidth ? `${s.frameWidth}x${s.frameHeight}` : '-';
      out.decoder = s.decoderImplementation;
    }
    if (s.type === 'outbound-rtp') {
      out.fps = s.framesPerSecond;
      out.bytes = s.bytesSent;
      out.res = s.frameWidth ? `${s.frameWidth}x${s.frameHeight}` : '-';
      out.encoder = s.encoderImplementation;
      out.limit = s.qualityLimitationReason;
    }
  });
  if (prev.bytes != null && out.bytes != null) out.kbps = Math.round(((out.bytes - prev.bytes) * 8) / (out.ts - prev.ts));
  if (out.packets != null && prev.packets != null) {
    const dl = out.lost - prev.lost, dp = out.packets - prev.packets;
    out.lossPct = dp + dl > 0 ? ((100 * dl) / (dp + dl)).toFixed(1) : '0.0';
  }
  return out;
}

export function formatInfo(i) {
  return [
    `route: ${i.route} (${i.localType || '-'} ↔ ${i.remoteType || '-'})`,
    `transport: ${i.protocol}`,
    `rtt: ${i.rtt ?? '-'} ms`,
    `fps: ${i.fps ?? '-'}`,
    `bitrate: ${i.kbps ?? '-'} kbps`,
    i.lossPct != null ? `loss: ${i.lossPct}%` : null,
    `res: ${i.res ?? '-'}`,
    i.encoder ? `enc: ${i.encoder}${i.limit && i.limit !== 'none' ? ` (limited: ${i.limit})` : ''}` : null,
    i.decoder ? `dec: ${i.decoder}` : null,
  ].filter(Boolean).join('  ·  ');
}
