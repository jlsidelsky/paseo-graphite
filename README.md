# Paseo for Graphite

Chrome side panel that lists the Paseo sessions on the Graphite PR you're viewing, shows their chat, sends messages, and starts new sessions (existing workspace or a fresh worktree checked out to the PR) with a model + effort picker. A floating button on the PR page shows how many sessions it has and opens the panel.

## Setup

Needs Node, Chrome and the Paseo desktop app, with its daemon on the default `127.0.0.1:6767`.

1. `npm install && npm run build`
2. `node scripts/allow-origin.mjs`: adds `chrome-extension://lflfieeldgejaiigfkkmofeekdlgloam` (pinned by `key` in the manifest) to `daemon.cors.allowedOrigins` in `~/.paseo/config.json`. Then **quit and reopen Paseo**; the daemon only reads the allowlist at startup. Until then the panel says it can't reach Paseo.
3. `node scripts/install-hook.mjs`: registers the PR-tagging hook in `~/.claude/settings.json` (see below). It's safe to run again. New Claude sessions pick it up.
4. Optional: `node scripts/pr-touch.mjs --backfill --dry-run` lists which of your existing sessions touched which PRs, from your Claude Code transcripts. Drop `--dry-run` to tag them.
5. `chrome://extensions` → Developer mode → Load unpacked → `ext/`
6. On a Graphite PR, click the toolbar icon (or ⌘⇧P) or the floating button.

`npm run watch` rebuilds on save; click reload on the extension card afterwards.

## How sessions are matched to a PR

A session shows up on a PR if either:

- its Paseo workspace is currently on that PR's branch, or
- it carries a `pr:<owner>/<repo>#<number>` label.

`scripts/pr-touch.mjs` sets those labels. It's a Claude Code `PostToolUse` hook on Bash, and it tags the agent in `PASEO_AGENT_ID` when a command actually works on a PR:

- `gh pr create`, `diff`, `review`, `comment`, `edit`, `merge`, `checkout`, `ready`, `close`, `reopen`;
- `gt submit`, for PRs it created or updated (not `no-op`).

Lookups (`gh pr view/list/checks`) and PR links that only appear in text don't count. Subagents inherit the parent's `PASEO_AGENT_ID`, so a PR a subagent opens is tagged on the session that started it. Without the hook, only the workspace match works, so PRs opened by subagents or on branches a workspace has left won't show.

Limits: only Claude Code agents are tagged, not Codex. Paseo can't remove labels, so a wrong tag stays.
