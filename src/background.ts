import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DAEMON_URL, parsePr, sessionsForPr } from "./pr";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite-bg", clientType: "browser" });
const paseo = createPaseoApi(daemon);
daemon.connect().catch(() => {});

const connected = () => daemon.getConnectionState().status === "connected";

// The worker may have just woken up, so give the daemon a moment before answering.
function ready() {
  return new Promise<boolean>((resolve) => {
    if (connected()) return resolve(true);
    const timer = setTimeout(() => (off(), resolve(false)), 5000);
    const off = daemon.subscribeConnectionStatus((s) => {
      if (s.status === "connected") (clearTimeout(timer), off(), resolve(true));
    });
  });
}

async function prSessions(url: string) {
  const pr = parsePr(url);
  if (!pr || !(await ready())) return null;
  const agents = (await sessionsForPr(paseo, pr)).agents.filter((a) => !a.archivedAt);
  return { count: agents.length, running: agents.filter((a) => a.status === "running").length };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "open-panel" && sender.tab) {
    void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    return;
  }
  if (msg.type === "pr-sessions") {
    prSessions(msg.url).then(reply, () => reply(null));
    return true;
  }
});
