# Paseo for Graphite

Chrome side panel that lists the Paseo sessions on the Graphite PR you're viewing, shows their chat, sends messages, and starts new sessions (existing workspace or a fresh worktree checked out to the PR) with a model + effort picker. A floating button on the PR page shows how many sessions it has and opens the panel.

## Setup

Needs Node, Chrome and the Paseo desktop app, with its daemon on the default `127.0.0.1:6767`.

1. `npm install && npm run build`
2. `node scripts/allow-origin.mjs`: adds `chrome-extension://lflfieeldgejaiigfkkmofeekdlgloam` (pinned by `key` in the manifest) to `daemon.cors.allowedOrigins` in `~/.paseo/config.json`. Then **quit and reopen Paseo**; the daemon only reads the allowlist at startup. Until then the panel says it can't reach Paseo.
3. Recommended: `node scripts/install-hook.mjs`. It registers a Claude Code hook in `~/.claude/settings.json` that records which PRs each session works on. Without it, the extension misses some sessions; see [Why the hook](#why-the-hook). It's safe to run again. New Claude sessions pick it up.
4. Optional: `node scripts/pr-touch.mjs --backfill --dry-run` lists which of your existing sessions touched which PRs, from your Claude Code transcripts. Drop `--dry-run` to tag them. The hook only sees commands run after it's installed, so this is how existing sessions get linked.
5. `chrome://extensions` → Developer mode → Load unpacked → `ext/`
6. On a Graphite PR, click the toolbar icon (or ⌘⇧P) or the floating button.

`npm run watch` rebuilds on save; click reload on the extension card afterwards.

## How sessions are matched to a PR

A session shows up on a PR if either:

- its Paseo workspace is currently on that PR's branch, or
- it carries a `pr:<owner>/<repo>#<number>` label.

### Why the hook

Paseo links a workspace to one PR: the one for the branch it's on right now. That covers the simple case, a session whose workspace is on the PR's branch, but misses sessions like these:

- **Subagents.** A session hands work to a subagent, and the subagent does it in its own separate worktree and opens the PR there. Paseo doesn't track that worktree, so nothing links the PR back to the session.
- **Several PRs from one session.** A session that builds a stack, or ships a follow-up fix, opens PRs on branches other than its own.
- **Workspaces that moved on.** Once a workspace switches to another branch, its sessions stop matching the PR they worked on before.
- **Reviews.** A session that reviews someone else's PR is usually on a different branch entirely.

The hook fills those gaps by tagging a session when it actually works on a PR.

**If you skip it**, the extension still works. The panel, chat and new sessions all behave the same, and a PR still lists the sessions whose workspace is on its branch. The sessions above just won't appear on the PR, and the floating button may show a lower count or not appear at all.

### What the hook counts

`scripts/pr-touch.mjs` is a Claude Code `PostToolUse` hook on Bash. When a command actually works on a PR, it adds the PR's label to the agent in `PASEO_AGENT_ID`. These commands count:

- `gh pr create`, `diff`, `review`, `comment`, `edit`, `merge`, `checkout`, `ready`, `close`, `reopen`;
- `gt submit`, for PRs it created or updated (not `no-op`).

Lookups (`gh pr view/list/checks`) and PR links that only appear in text don't count, so a session that just mentions a PR isn't linked to it. Subagents inherit the parent's `PASEO_AGENT_ID`, so a PR a subagent opens is tagged on the session that started it.

Limits: only Claude Code agents are tagged, not Codex. Paseo can't remove labels, so a wrong tag stays.
