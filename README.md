# Paseo for Graphite

Chrome side panel that lists the Paseo sessions on the Graphite or GitHub PR you're viewing, shows their chat, and lets you work with them without leaving the PR:

- send messages, with `/` command and skill suggestions, and paste or drop images into the composer;
- read tool calls at a glance: shell commands with their output, file edits as diffs, reads and searches with their results, failures in red;
- answer permission prompts, including agent questions (single or multiple choice, or your own answer) and plan approvals with the plan rendered; stop a running turn, and rewind to an earlier message;
- change a session's permission mode;
- see how full the session's context window is, as Paseo shows it (amber from 70%, red above 90%; hover for token counts). Only for sessions whose provider reports it, currently Claude;
- start a new session in an existing workspace or a fresh worktree checked out to the PR, with a model, effort and mode picker; its first message starts with the PR link;
- see sessions for the other PRs in the same stack;
- on a Linear issue, see the sessions for that ticket (a workspace on a branch containing its ID, or a `ticket:<ID>` label) and start one in a fresh worktree on a branch named for the ticket, its first message the ticket title and link. The Linear page's **▶ Paseo** button opens that form;
- anywhere else, see every session grouped into needs you, running and recently finished, and open any of them;
- pin (📌) the panel to what it's showing, so it stays put while you switch tabs. The composer keeps a draft per PR, ticket or the all-sessions view;
- hand a review comment or selected diff lines to the session: **→ Paseo** on a selection in the diff drops the lines into the composer, and a comment's **Evaluate**, **Address** or **Insert** drops it in wrapped in that prompt (or as is). On GitHub this works in both the classic and the new "Files changed" view;
- on a PR, fill the composer from the actions bar. Its first control is the scope: **This PR ▾**, **Whole stack** or any PRs you tick (greyed out as "This PR (no stack)" when the PR isn't in one; back to This PR when you switch PRs). **Review ▾**, **Fix CI** and **Feedback ▾** all cover that scope: Review lists your presets and the review commands and skills your Claude and Codex sessions have (like `/code-review`); Fix CI lists each PR's failing checks when Paseo knows them, else asks the agent to run `gh pr checks` (greyed out when they all pass); Feedback evaluates or addresses each PR's latest review feedback. Nothing is sent: pick a session, or open ＋ New, which then suggests the topmost PR in scope (a new worktree for a review, its existing workspace for Fix CI and Feedback) and the preset's model, effort and mode;
- customize those menus under ⚙ → **Customize prompts…**: presets per action (a prompt, or a slash command plus extra instructions), each with its own scope (this PR, whole stack, or ask), session (new worktree, the PR's workspace, or the selected session), model, effort and mode, and favorite / hidden / order. The review and feedback commands the panel finds can be renamed, hidden, favorited, reordered and given the same defaults. Presets sync through your Chrome profile.

A floating button on the PR page shows how many sessions it has, updated live, and opens the panel.

On a Linear issue, **▶ Paseo** next to the issue's copy-link buttons opens the panel's new-session form for that ticket (top right of the window if Linear's toolbar can't be found).

When a session on a PR you have open finishes a turn or needs you, the tab gets a dot on its favicon and title, and Chrome shows a notification that opens the panel on that PR. Both can be turned off under ⚙ in the panel.

## Setup

Needs Node, Chrome and the Paseo desktop app, with its daemon on the default `127.0.0.1:6767`.

1. `npm install && npm run build`
2. `node scripts/allow-origin.mjs`: adds `chrome-extension://lflfieeldgejaiigfkkmofeekdlgloam` (pinned by `key` in the manifest) to `daemon.cors.allowedOrigins` in `~/.paseo/config.json`. Then **quit and reopen Paseo**; the daemon only reads the allowlist at startup. Until then the panel says it can't reach Paseo.
3. Recommended: install the PR-tagging plugin, which records which PRs each session works on. Without it, the extension misses some sessions; see [Why the plugin](#why-the-plugin).
   1. Turn on plugins in Paseo under **Settings → Plugins** (or set `"pluginsEnabled": true` in `~/.paseo/config.json` and run `paseo reload`). Plugins are trusted, unsandboxed code, so read `plugin/` first.
   2. `cd plugin && npm install && paseo plugin install "$PWD"`
   3. `paseo plugin ls` should show `paseo-graphite-pr-tags` as `running`. On first start it tags your past sessions in the background; `paseo plugin logs paseo-graphite-pr-tags` shows what it found.
4. `chrome://extensions` → Developer mode → Load unpacked → `ext/`
5. On a Graphite or GitHub PR, click the toolbar icon (or ⌘⇧P) or the floating button.

`npm run watch` rebuilds on save; click reload on the extension card afterwards. After editing the plugin, run `paseo plugin reload paseo-graphite-pr-tags`.

## How sessions are matched to a PR

A session shows up on a PR if either:

- its Paseo workspace is currently on that PR's branch, or
- it carries a `pr:<owner>/<repo>#<number>` label.

Sessions started from the panel get the label when they're created, `ticket:<ID>` for ones started on a Linear issue.

### Why the plugin

Paseo links a workspace to one PR: the one for the branch it's on right now. That covers the simple case, a session whose workspace is on the PR's branch, but misses sessions like these:

- **Subagents.** A session hands work to a subagent, and the subagent does it in its own separate worktree and opens the PR there. Paseo doesn't link that worktree to the session's workspace.
- **Several PRs from one session.** A session that builds a stack, or ships a follow-up fix, opens PRs on branches other than its own.
- **Workspaces that moved on.** Once a workspace switches to another branch, its sessions stop matching the PR they worked on before.
- **Reviews.** A session that reviews someone else's PR is usually on a different branch entirely.

The plugin fills those gaps by tagging a session when it actually works on a PR. It runs inside Paseo, so it works for every provider (Claude, Codex and the rest) and whether or not Chrome is open.

**If you skip it**, the extension still works. The panel, chat and new sessions all behave the same, and a PR still lists the sessions whose workspace is on its branch. The sessions above just won't appear on the PR, and the floating button may show a lower count or not appear at all.

### What the plugin counts

After every turn, the plugin reads the session's shell commands, and its subagents' commands, from Paseo's history. A command counts when it actually works on a PR:

- `gh pr create`, `diff`, `review`, `comment`, `edit`, `merge`, `checkout`, `ready`, `close`, `reopen`;
- `gt submit`, for PRs it created or updated (not `no-op`).

Lookups (`gh pr view/list/checks`) and PR links that only appear in text don't count, so a session that just mentions a PR isn't linked to it. A subagent's PRs are tagged on the session that started it.

Limits: a session whose worktree was deleted can't load its history, so the first-start scan skips it. Paseo can't remove labels, so a wrong tag stays.
