# Telegram CLI for AI Agents

Personal Telegram account CLI built with TypeScript, `pnpm`, [`incur`](https://github.com/wevm/incur), and [`mtcute`](https://mtcute.dev). Adapted under the MIT License from [gskril/telegram-cli](https://github.com/gskril/telegram-cli) with offline diagnostics (`status`), per-chat message search (`search`), and multi-chat daily triage (`digest`) for personal agent workflows.

## Setup

1. Create personal Telegram API credentials (`API ID` and `API hash`) at [my.telegram.org/apps](https://my.telegram.org/apps).
2. Install dependencies, build the CLI, and run smoke tests:

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

3. Configure credentials and authenticate once interactively:

```bash
telegram setup
telegram auth --read-only
telegram status
telegram whoami
```

Use `telegram auth --read-only` when running autonomous background agents or daily digests so write commands (`send`, `group create`, `group add`, `group remove`, `group leave`) stay blocked at the CLI layer. Re-run `telegram auth` without `--read-only` whenever you intentionally want write access.

## Commands

| Command | Purpose |
| :--- | :--- |
| `telegram setup [--force]` | Store `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the user config file (`0600` permissions) |
| `telegram auth [--read-only] [--force]` | Log into your personal Telegram account and persist the SQLite session |
| `telegram status` | Inspect config path, session presence, environment credentials, and `readOnly` state offline |
| `telegram whoami` | Show the authenticated account and local session details |
| `telegram logout` | Clear the active local Telegram session |
| `telegram folders` | List chat folder IDs and titles |
| `telegram chats [--with <user>] [--folder <id-or-title>] [--limit <n> \| --all] [--unread-only]` | List dialogs, shared groups, or unread chats |
| `telegram unread [--chats-limit <n>] [--messages-limit <n>]` | Show unread chats and recent unread message previews |
| `telegram read <chat> [--limit <n>] [--cursor <cursor>]` | Read message history pages oldest first with `nextCursor` pagination |
| `telegram search <chat> <query> [--limit <n>]` | Search messages inside a specific chat by `@username` or numeric ID |
| `telegram digest [--limit <n>] [--unread-only] [--messages-limit <n>]` | Summarize recent messages across top or unread chats for daily agent triage |
| `telegram contacts <query>` | Search Telegram contacts by name fragment, `@username`, or phone |
| `telegram resolve <chat>` | Resolve `@username`, numeric ID, or `me` to canonical Telegram peer metadata |
| `telegram mark-read <chat> [--max-id <id>]` | Mark dialog history as read |
| `telegram draft <chat> --text <text>` | Save or clear (`--text ""`) a cloud text draft |
| `telegram send <chat> [--text <text>] [--file <path-or-url>] [--reply-to <id>]` | Send text or media to a chat |
| `telegram group <create\|add\|remove\|count\|leave>` | Manage groups, supergroups, and memberships |

## Daily Agent Examples

```bash
telegram status --json
telegram unread --json
telegram digest --unread-only --limit 15 --messages-limit 8 --json
telegram search -1001234567890 "deploy" --limit 20 --json
telegram read -1001234567890 --limit 30
telegram draft 500894395 --text "Follow up after morning sync."
```

## Security Notes

1. Credentials and session state stay strictly inside your user-scoped config/state directory (`~/Library/Application Support/telegram-cli` on macOS, `~/.config/telegram-cli` and `~/.local/state/telegram-cli` on Linux) or environment variables (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`).
2. `telegram status` reports presence flags only and never prints secret values.
3. Cloud drafts are text-only per Telegram API rules; attach files only through `telegram send --file` when approved.
