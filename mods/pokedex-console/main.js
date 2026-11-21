import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, focused, props, run, spaces, shared, openOverlay, exec, theme, nextCommand, notify, readTextFile, home } from "herdr";
import { game, trainerLevel, options, BADGES, CAUGHT, ALERTS, ENCOUNTER_MS, WILD_MAX, STREAK_NEED } from "./game.js";
import { call, streakNow, weekNow, rulesMismatch } from "./server.js";

// Game options, as commands (keys.json, the palette, herdr-app do): pokedex-console.alert-off,
// .alert-on, .alert-smart, .hard-mode-on, .hard-mode-off. Each sets a fixed value, so the several
// shown copies of this mod can all run it.
const COMMANDS = {
  "alert-off": ["alert", "off"], "alert-on": ["alert", "on"], "alert-smart": ["alert", "smart"],
  "hard-mode-on": ["hardMode", true], "hard-mode-off": ["hardMode", false],
};
const ALERT_TIP = {
  off: "never", on: "always", smart: "only while no agent is working",
};
const setOption = (key, value) => call("setOption", key, value)
  .catch((error) => notify({ title: "Pokedex option not saved", body: error.message, level: "error" }));

const C = {
  housing: "#9b293a", raised: "#bd3c4c", seam: "#641b2b",
  highlight: "#e8797d", lcd: "#d9e8bc", ink: "#244438",
  cyan: "#71d5df", cream: "#f7eed7", screen: "#17251f",
};
const PIXEL = "PxPlus IBM VGA 8x16";

export default class PokedexConsole extends View {
  init(_props, cx) {
    this.width = 300;
    this.git = null;
    if (props()?.role === "status") {
      cx.timer.every(5000, (cx) => { this.refreshGit(cx); this.refreshUsage(cx); });
      this.refreshGit(cx);
      this.refreshUsage(cx);
    }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (COMMANDS[c]) setOption(...COMMANDS[c]);
        else console.log(`pokedex-console: unknown command ${c}`);
        cx.notify();
      }
    });
  }

  // Local addition: Claude plan usage (5h and weekly). The Claude Code status line
  // (~/.claude/statusline-command.sh) saves its input JSON, which carries rate_limits.
  refreshUsage(cx) {
    cx.spawn(async (cx) => {
      try {
        const data = JSON.parse(await readTextFile(`${home()}/.cache/claude-usage/last.json`));
        this.usage = data.rate_limits ?? null;
      } catch { this.usage = null; }
      cx.notify();
    });
  }

  usageChip(t) {
    const u = this.usage;
    if (!u) return null;
    const now = Date.now() / 1000;
    const left = (secs) => {
      const m = Math.max(0, Math.round((secs - now) / 60));
      return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
        : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    };
    // A window whose reset time has passed is back at 0 until a session reports again.
    const pct = (w) => !w ? null : w.resets_at && w.resets_at < now ? 0 : Math.round(w.used_percentage ?? 0);
    const color = (p) => p >= 90 ? t.blocked : p >= 70 ? "#e0b050" : C.lcd;
    const part = (label, w) => {
      const p = pct(w);
      if (p === null) return null;
      return h_flex().flex_none().gap(4).items_center()
        .child(div().text_color("#b6c6b8").child(label))
        .child(div().w(36).h(5).rounded(2).bg("#ffffff1c")
          .child(div().h_full().rounded(2).w(Math.max(1, Math.min(36, p * 0.36))).bg(color(p))))
        .child(div().text_color(color(p)).child(`${p}%`));
    };
    const tip = [["5h", u.five_hour], ["Week", u.seven_day]]
      .filter(([, w]) => w).map(([l, w]) => `${l}: ${pct(w)}% used, resets in ${left(w.resets_at)}`).join(" \u00b7 ");
    return h_flex().id("status-usage").flex_none().gap(10).items_center().px(5).rounded(3)
      .tooltip(`Claude usage \u00b7 ${tip}`)
      .children([part("5h", u.five_hour), part("7d", u.seven_day)].filter(Boolean));
  }

  // The tall grass count, and the two options. Clicking the alert chip cycles off, on, smart;
  // clicking hard mode toggles it.
  grassAndOptions(t) {
    const waiting = game().wild.filter((e) => Date.now() - e.at <= ENCOUNTER_MS).length;
    const o = options();
    const chip = (id, tip, onClick, child) => h_flex().id(id).flex_none().gap(5).items_center().px(5).rounded(3)
      .cursor_pointer().hover(s => s.bg("#ffffff14")).tooltip(tip).on_click(onClick).child(child);
    return h_flex().flex_none().gap(8).items_center()
      .when(waiting > 0, el => el.child(chip("status-grass", "Wild Pokemon waiting: open the encounter",
        () => run("mod.open", { name: "pokedex-encounter" }),
        div().text_color(t.blocked).child(`Tall grass ${waiting}/${WILD_MAX}`))))
      .child(chip("status-alert", `New wild Pokemon alert ${ALERT_TIP[o.alert] ?? o.alert}. Click to change.`,
        () => setOption("alert", ALERTS[(ALERTS.indexOf(o.alert) + 1) % ALERTS.length]),
        div().child(`Alert ${o.alert}`)))
      .child(chip("status-hard", o.hardMode ? "Hard mode: an agent left waiting 10 min makes its project's next task earn no XP. Click to turn off."
        : "Hard mode off: nothing faints; a fast answer gives that project's next task +25% XP. Click to turn on.",
        () => setOption("hardMode", !o.hardMode),
        div().text_color(o.hardMode ? t.blocked : "#b6c6b8").child(`Hard ${o.hardMode ? "on" : "off"}`)));
  }

  // Ahead/behind and uncommitted count for the focused terminal's folder.
  refreshGit(cx) {
    const cwd = focused()?.cwd;
    const machine = spaces().find(s => s.active)?.machine ?? undefined;
    if (!cwd) { this.git = null; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["status", "--porcelain=v2", "--branch"], { cwd, on: machine, timeout: 4000 });
        if (r.code !== 0) { this.git = null; cx.notify(); return; }
        const ab = r.stdout.match(/^# branch\.ab \+(\d+) -(\d+)/m);
        const dirty = r.stdout.split("\n").filter(l => l && !l.startsWith("#")).length;
        this.git = { ahead: ab ? +ab[1] : 0, behind: ab ? +ab[2] : 0, dirty };
      } catch (e) {
        console.log("pokedex status git:", String(e));
        this.git = null;
      }
      cx.notify();
    });
  }

  button(id, label, action, width = 64) {
    return div().id(id).w(width).h(26).flex_none().flex().items_center()
      .justify_center().rounded(4).border(1).border_color(C.highlight)
      .bg(C.housing).text_color(C.cream).text_size(11)
      .cursor_pointer().hover(s => s.bg(C.raised))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action).child(label);
  }

  lens(compact) {
    return div().id("pokedex-sensor").size(compact ? 32 : 46).flex_none()
      .rounded(24).bg(C.seam).p(3).cursor_pointer()
      .tooltip("Open command palette")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("app.palette"))
      .hover(s => s.bg(C.highlight))
      .child(div().size_full().rounded(22).bg(C.cream).p(3)
        .child(div().size_full().rounded(20).bg("#298eaa").p(3)
          .child(div().size_full().rounded(18).bg(C.cyan)
            .child(div().size(8).mt(3).ml(3).rounded(4).bg("#edffff")))));
  }

  brand(compact) {
    const all = agents();
    const working = all.some(a => a.status === "working");
    const blocked = all.some(a => a.status === "blocked");
    return v_flex().size_full().justify_end().px(compact ? 8 : 16).pb(13)
      .gap(12).bg(C.housing).border_b(2).border_color(C.highlight)
      .child(h_flex().gap(12).items_center().when(compact, el => el.justify_center())
        .child(this.lens(compact))
        .when(!compact, el => el.child(v_flex().gap(2).min_w(0).flex_1()
          .child(div().font_family(PIXEL).text_size(23).line_height("24px")
            .text_color(C.cream).child("POKEDEX"))
          .child(div().text_size(10).font_semibold().text_color("#f3bfba")
            .child("AGENT CONTROL"))))
        .when(!compact, el => el.child(h_flex().gap(5).self_start()
          .child(div().size(7).rounded(4).bg(blocked ? "#ffcc67" : "#6e2930")
            .tooltip(blocked ? "Agents need you" : "No blocked agents"))
          .child(div().size(7).rounded(4).bg(working ? C.cyan : "#6e2930")
            .tooltip(working ? "Agents working" : "No working agents"))
          .child(div().size(7).rounded(4).bg(C.lcd).tooltip("Herdr running")))))
      .when(!compact, el => el.child(h_flex().gap(5)
        .children([1, 2, 3].map(i => div().h(3).w(i === 1 ? 84 : 20)
          .rounded(2).bg(C.seam)))));
  }

  // The trainer strip: level, streak and badge pips; it opens the trainer card. What waits on the card
  // (the starter choice, the New Pokedex explainer, a gift to choose) takes the badges' place until done.
  trainer(compact) {
    const g = game();
    const streak = streakNow(g);
    // The server running other rules than these mods' copy comes first: what's drawn may be off.
    const news = rulesMismatch() !== null ? "Rules differ from the server: run scripts/sync-game.sh"
      : !g.party.length ? "Choose your starter"
      : g.lifetime > 0 && !g.seen.includes("phase2") ? "New Pokedex: see what changed"
      : g.gifts.pending.length ? "A gift is waiting" : null;
    return h_flex().id("pokedex-trainer-open").flex_1().min_w(0).overflow_hidden().h(26).px(8).gap(4).items_center()
      .rounded(4).bg(C.lcd).text_color(C.ink).text_size(11).cursor_pointer()
      .tooltip(`${news ? news + " \u00b7 " : ""}Trainer Lv ${trainerLevel(g)} \u00b7 ${(shared(CAUGHT) ?? []).length}/151 caught \u00b7 ${g.tasks} tasks \u00b7 open trainer card`)
      .hover(s => s.bg("#c8dca6"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openOverlay({ mod: "pokedex-trainer", kind: "dialog", width: 600, height: 800 }))
      .child(div().flex_none().font_family(PIXEL).text_size(14).child(`TR${trainerLevel(g)}`))
      .when(compact && Boolean(news), el => el.child(div().flex_none().font_bold().text_color(C.housing).child("!")))
      .when(!compact && Boolean(news), el => el
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(C.housing).child(news)))
      .when(!compact && !news, el => el
        // Until a streak starts, the week's active days toward one.
        .child(div().flex_none().font_semibold().text_color(streak ? "#b4472f" : C.ink + "80").child(streak ? `\u2668${streak}` : `\u2668${weekNow(g)}/${STREAK_NEED}`))
        .child(div().flex_1())
        .children(BADGES.filter(b => !b.rank).map(b => image(`mods/pokedex-trainer/badges/${b.id}.png`).size(13).flex_none()
          .when(!g.badges.includes(b.id), el => el.opacity(0.25)))));
  }

  footer(compact) {
    return h_flex().size_full().px(compact ? 8 : 14).py(10).gap(8).items_center()
      .bg(C.housing).border_t(2).border_color(C.seam)
      .when(compact, el => el.child(this.trainer(true)))
      .when(!compact, el => el
        .child(this.trainer(false))
        .child(this.button("pokedex-keys", "Keys", () => run("app.help"), 44))
        .child(this.button("pokedex-settings", "Settings",
          () => run("app.settings", { section: "look" }), 72)));
  }

  status() {
    const all = agents();
    const space = spaces().find(s => s.active);
    const current = all.find(a => a.address === focused()?.terminal);
    const t = theme();
    const counts = [
      ["blocked", "Needs you", t.blocked], ["done", "Done", t.done],
      ["working", "Working", t.working], ["idle", "Idle", t.idle],
    ].map(([status, label, color]) => {
      const list = all.filter(a => a.status === status);
      // Each click goes to the one after the agent in front, so repeated clicks walk the list.
      const at = list.findIndex(a => a.address === focused()?.terminal);
      return { status, label, color, count: list.length, first: list[(at + 1) % list.length] };
    });
    const branch = spaces().find(s => s.active)?.branch;
    const g = this.git;
    return h_flex().size_full().px(14).gap(14).items_center().min_w(0)
      .bg(C.screen).text_size(11).text_color("#b6c6b8")
      .child(div().size(6).rounded(3).bg(C.cyan).flex_none())
      .child(div().max_w(250).truncate().child(space?.name ?? "Herdr"))
      .when(Boolean(current), el => el.child(div().max_w(160).truncate()
        .text_color(C.cream).child(current.program?.name ?? current.app)))
      .child(div().flex_1())
      .when(Boolean(branch), el => el.child(h_flex().flex_none().gap(6).items_center()
        .child(div().max_w(200).truncate().text_color(C.cyan).child(`\u2387 ${branch}`))
        .when(Boolean(g?.ahead), el => el.child(div().text_color(t.done).child(`\u2191${g.ahead}`)))
        .when(Boolean(g?.behind), el => el.child(div().text_color(t.blocked).child(`\u2193${g.behind}`)))
        .when(Boolean(g?.dirty), el => el.child(div().text_color(C.cream).child(`\u25cf${g.dirty}`)))))
      .child(div().flex_1())
      .when(Boolean(this.usage), el => el.child(this.usageChip(t)))
      .child(this.grassAndOptions(t))
      .children(counts.filter(c => c.count > 0).map(c =>
        h_flex().id(`status-${c.status}`).flex_none().gap(5).items_center().px(5).rounded(3)
          .cursor_pointer().hover(s => s.bg("#ffffff14"))
          .tooltip(`Jump to ${c.first.program?.name ?? c.first.app ?? "agent"}`)
          .on_click(() => run("agent.focus", { terminal: c.first.address }))
          .child(div().size(6).rounded(3).bg(c.color))
          .child(div().text_color(c.color).child(`${c.label} ${c.count}`))));
  }

  render() {
    const role = props()?.role ?? "brand";
    const compact = this.width < 160;
    return div().id("pokedex-console").size_full().min_w(0)
      .font_family("Geist")
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(role === "status" ? this.status() : role === "footer" ? this.footer(compact) : this.brand(compact));
  }
}
