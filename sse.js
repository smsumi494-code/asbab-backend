// sse.js — keeps a list of connected browsers (via Server-Sent Events) and
// broadcasts a "refresh" ping the instant any entry changes, so everyone's
// feed updates live — no waiting, no manual refresh.
const clients = new Set();

function addClient(res) {
  clients.add(res);
}

function removeClient(res) {
  clients.delete(res);
}

function broadcastRefresh() {
  const msg = `data: refresh\n\n`;
  for (const res of clients) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

module.exports = { addClient, removeClient, broadcastRefresh };
