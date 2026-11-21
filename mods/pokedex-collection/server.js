// The Pokedex agents server (its own repo, pokedex-agents-server; http://127.0.0.1:7151) owns the game: every change
// goes through call(). pokedex-agents keeps Herdr's shared state a mirror of it (mirror()), so
// game() and shared("pokedex.*") read as before in every mod. Copied to each mod by scripts/sync-game.sh.
import { WebSocket } from "websocket";
import { shared, setShared, notify, exec, agents, readTextFile, home, playSound } from "herdr";
import { shouldAlert, quests, liveStreak, liveWeek, OPTIONS, RULES_VERSION, KEYS as KEY_MAP, LABELS } from "./game.js";

// Local fix: the port follows the server's config.json (state folder), which mirror() reads into
// shared "pokedex.port"; every mod copy reads it from there. 7151 is the server's default.
export const DEFAULT_PORT = 7151;
export const server = () => `127.0.0.1:${shared("pokedex.port") ?? DEFAULT_PORT}`;
async function configuredPort() {
  try {
    const text = await readTextFile(`${home()}/.local/state/pokedex-agents-server/config.json`);
    const port = Number(JSON.parse(text ?? "{}").port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch { return DEFAULT_PORT; }
}
const KEYS = ["pokedex.game", "pokedex.caught", "pokedex.partners", "pokedex.projects"];
// Mirrored too, but never merged: the options belong to the server's save; the readable key -> saved
// key and saved key -> label maps are kept on this machine by the server (see game.js).
const MIRRORED = [...KEYS, OPTIONS, KEY_MAP, LABELS];

// What the server computed from its clock (today's quests, the live streak, the week), mirrored here: drawn as
// sent, so an older or newer copy of the rules in a mod never shows different ones. An older server
// sends none, and the mod's own copy is used.
export const VIEW = "pokedex.view";
export const questsNow = (g) => shared(VIEW)?.quests ?? quests(g);
export const streakNow = (g) => shared(VIEW)?.streak ?? liveStreak(g);
// The active days among the last 7: shown out of STREAK_NEED while the streak is 0.
export const weekNow = (g) => shared(VIEW)?.week ?? liveWeek(g);
// The server's rules version when it differs from this copy's (time to run scripts/sync-game.sh).
export const rulesMismatch = () => { const v = shared(VIEW); return v && v.rules !== RULES_VERSION ? v.rules : null; };

// One request; throws only when the server can't be reached.
async function post(action, args, at) {
  const res = await fetch(`http://${server()}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args, origin: "herdr", ...(at ? { at } : {}) }),
  });
  return res.json();
}
// Resolves with the action's value; rejects with the server's error, or when it is down.
export async function call(action, ...args) {
  let r;
  try {
    r = await post(action, args);
  } catch (error) {
    throw new Error(`Pokedex server not reachable: ${error}`);
  }
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// --- What agents did, kept when the server can't be reached. Each report carries when it happened;
// one the server can't take now waits in this mod's localStorage and is sent once the server is back,
// oldest first (the server counts it on its own day). A report never overtakes an older one still
// waiting, so a commit follows its turn.
const EVENTS = new Set(["taskFinished", "subTaskFinished", "unblocked", "result"]);
const outbox = () => { try { return JSON.parse(localStorage.getItem("outbox") ?? "[]"); } catch { return []; } };
const keep = (box) => (box.length ? localStorage.setItem("outbox", JSON.stringify(box)) : localStorage.removeItem("outbox"));
let flushing = null;
// Sends what waits, oldest first, until it's all sent or the server is still out of reach.
export function flushOutbox() {
  flushing ??= (async () => {
    for (let box = outbox(); box.length; box = outbox()) {
      const e = box[0];
      let r;
      try { r = await post(e.action, e.args, e.at); } catch { return; }
      if (!r.ok) console.log(`pokedex: queued ${e.action} refused: ${r.error}`);
      keep(outbox().slice(1));
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
async function report(action, args) {
  const e = { action, args, at: Date.now() };
  await flushOutbox();
  if (outbox().length) return void keep([...outbox(), e]);
  let r;
  try {
    r = await post(action, args, e.at);
  } catch {
    return void keep([...outbox(), e]); // the mirror restarts the server and flushes once it's back
  }
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
// Shares progress on X: the server puts the card image on the clipboard, and X's compose
// window opens with the post's text. Resolves with the message to show.
export async function shareOnX() {
  let r;
  try {
    r = await (await fetch(`http://${server()}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  } catch (error) {
    throw new Error(`Pokedex server not reachable: ${error}`);
  }
  if (!r.ok) throw new Error(r.error);
  // Local fix: `open` is macOS only. Try it, then xdg-open, wslview, and Windows' explorer.exe (WSL).
  await exec("sh", ["-c", 'open "$1" 2>/dev/null || xdg-open "$1" 2>/dev/null || wslview "$1" 2>/dev/null || explorer.exe "$1"', "sh", r.url], { timeout: 5000 }).catch(() => {});
  return r.copied ? "Card copied: paste it into the post" : `X opened; the card couldn't be copied. It's saved at ${r.card ?? "the server's state folder"}`;
}

// For changes nobody waits on: a failure is logged, not thrown. Agent reports are queued while the
// server is out of reach.
export const send = (action, ...args) => (EVENTS.has(action) ? report(action, args) : call(action, ...args))
  .catch((error) => console.log(`pokedex: ${action} failed: ${error.message}`));

// A server that isn't running is started from where it is installed: $POKEDEX_SERVER_DIR, else
// ~/.local/share/pokedex-agents-server, else ~/workspace-perso/pokedex-agents-server. A second
// copy exits at once, so Herdr and Rex starting it together is fine.
async function startServer() {
  const script = `for d in "$POKEDEX_SERVER_DIR" "$HOME/.local/share/pokedex-agents-server" "$HOME/workspace-perso/pokedex-agents-server"; do
    if [ -n "$d" ] && [ -f "$d/bin/pokedex-agents-server.js" ]; then
      mkdir -p "$HOME/.local/state/pokedex-agents-server"
      nohup "$(command -v bun || echo "$HOME/.bun/bin/bun")" "$d/bin/pokedex-agents-server.js" >> "$HOME/.local/state/pokedex-agents-server/server.log" 2>&1 &
      exit 0
    fi
  done
  echo "pokedex-agents-server not installed" >&2; exit 1`;
  const r = await exec("sh", ["-lc", script], { timeout: 5000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
}

// Follows /ws for as long as `cx` lives: each state the server sends is written into Herdr's
// shared state (only the keys that changed, so mods redraw only on real news), and news this app
// caused is shown as a toast. Quiet news (level-ups, items, quests) is never shown; a new wild Pokemon
// only when shouldAlert() allows it for the agents busy right now (else it just waits in the tall grass). On the first state it merges Herdr's old save into the server's, once.
export async function mirror(cx) {
  const since = Date.now();
  let shown = since, tries = 0, merged = false;
  for (;;) {
    try {
      const port = await configuredPort();
      if (shared("pokedex.port") !== port) setShared("pokedex.port", port);
      let ws;
      try {
        ws = await WebSocket.connect(`ws://${server()}/ws`);
      } catch (error) {
        // Local fix: only a failed connect means the server is down; start it once per outage.
        if (tries++ === 0) {
          console.log(`pokedex: server not reachable (${error}); starting it`);
          try { await startServer(); } catch (e) { console.log(`pokedex: could not start the server: ${e}`); }
        }
        await cx.sleep(Math.min(10000, 1000 * tries));
        continue;
      }
      flushOutbox(); // reports queued while it was out of reach
      for (;;) {
        const msg = await ws.read();
        const state = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
        if (!merged) {
          // Local fix: shared() gives null for a key never set, so leave those out (a fresh install
          // otherwise sends nulls and the server's merge throws). Herdr's own flag records that this
          // save was merged or had nothing to merge; without it, the next start would merge the
          // mirrored copy of the server's save into itself and double every count.
          const done = shared("pokedex.herdrMerged") === true || (state.shared["pokedex.merged"] ?? []).includes("herdr");
          const mine = Object.fromEntries(KEYS.map((k) => [k, shared(k)]).filter(([, v]) => v != null));
          if (!done && Object.keys(mine).length) {
            await call("merge", "herdr", mine); // throws until it succeeds: nothing is mirrored before
            setShared("pokedex.herdrMerged", true);
            merged = true;
            continue; // the merged state comes next
          }
          if (!done) setShared("pokedex.herdrMerged", true);
          merged = true;
        }
        tries = 0;
        for (const k of MIRRORED) {
          const v = state.shared[k];
          if (v !== undefined && JSON.stringify(v) !== JSON.stringify(shared(k))) setShared(k, v);
        }
        if (state.view && JSON.stringify(state.view) !== JSON.stringify(shared(VIEW))) setShared(VIEW, state.view);
        for (const n of state.notes ?? []) {
          if (n.origin !== "herdr" || n.at <= shown) continue;
          shown = n.at;
          // Local fix: the server plays jingles only on macOS; elsewhere it sends them as a note and
          // Herdr plays them (silent when Herdr's sounds are off).
          if (n.sound && /^[a-z]+\.mp3$/.test(n.sound)) { try { playSound(`mods/pokedex-agents/sounds/${n.sound}`); } catch {} }
          if (n.quiet) continue;
          if (n.encounter && !shouldAlert(agents().filter((a) => a.status === "working").length)) continue;
          notify({ title: n.title, body: n.body, level: n.level, icon: n.icon ?? undefined, action: n.action ?? undefined, timeout: n.timeout ?? undefined });
        }
        cx.notify();
      }
    } catch (error) {
      // Connected but something failed (a refused merge, bad data): back off, don't start a server.
      tries++;
      console.log(`pokedex: server connection lost (${error})`);
    }
    await cx.sleep(Math.min(10000, 1000 * tries));
  }
}
