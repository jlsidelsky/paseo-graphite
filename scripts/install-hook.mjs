// Registers pr-touch.mjs as a Claude Code PostToolUse hook in ~/.claude/settings.json.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const hookScript = fileURLToPath(new URL("./pr-touch.mjs", import.meta.url));
const command = `node ${JSON.stringify(hookScript)}`;
const link = `${homedir()}/.claude/settings.json`;
// Write through a symlinked settings file rather than replacing the link.
const path = existsSync(link) ? realpathSync(link) : link;
const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

settings.hooks ??= {};
const post = (settings.hooks.PostToolUse ??= []);
if (post.some((m) => m.hooks?.some((h) => h.command?.includes("pr-touch.mjs")))) {
  console.log(`Already installed in ${path}`);
} else {
  post.push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Added PostToolUse hook to ${path}:\n  ${command}`);
}
