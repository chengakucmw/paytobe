// WebSocket fan-out hub: owns the app/openclaw socket maps and the notify
// helpers that read them.
//
// Created once at startup. The server destructures the returned members back
// into the same local names it used before (appSockets, notifyOpenClaw, …) so
// route/WS code and the test exports are unchanged. notifyOpenClaw and
// openclawSockets returned here reference the SAME Map instance, which the
// regression test relies on (it seeds openclawSockets, then asserts delivery).

export function createWsHub() {
  const appSockets = new Map();
  const openclawSockets = new Map();

  function addSocket(map, key, socket) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(socket);
  }

  function removeSocket(map, key, socket) {
    const set = map.get(key);
    if (!set) return;
    set.delete(socket);
    if (!set.size) map.delete(key);
  }

  function notifyApp(deviceId, message) {
    sendSet(appSockets.get(deviceId), message);
  }

  function notifyOpenClaw(key, message) {
    // M1: deliver to exactly one bucket — the connection_id (modern agents) or a
    // device_id (legacy). The old code ALSO fanned every message out to a shared
    // "default" bucket that collected every anonymous legacy socket, leaking one
    // connection's request_id/tx_hash to all of them and double-delivering. A
    // falsy key means "no route" and is dropped, never broadcast.
    if (!key) return;
    sendSet(openclawSockets.get(key), message);
  }

  function sendSet(set, message) {
    if (!set) return;
    const text = JSON.stringify(message);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  function countOpenSockets(map) {
    return Array.from(map.values()).reduce((total, sockets) => {
      return total + Array.from(sockets).filter((socket) => socket.readyState === socket.OPEN).length;
    }, 0);
  }

  return {
    appSockets,
    openclawSockets,
    addSocket,
    removeSocket,
    notifyApp,
    notifyOpenClaw,
    sendSet,
    countOpenSockets
  };
}
