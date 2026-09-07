# coros-workout-mcp

> ⚠️ **Unofficial, community-led project — not affiliated with COROS.**
> COROS now offers an official MCP server at
> [coroslab/COROS-MCP](https://github.com/coroslab/COROS-MCP). If you want a
> supported, first-party option, use that. This project remains an independent,
> community-built tool.

MCP server for creating COROS **strength and running** workouts via the Training Hub API. Lets Claude design workouts and push them directly to your COROS watch.

See the MCP in action: [YouTube walkthrough](https://www.youtube.com/watch?v=I2I2p7hNZjM)

## Disclaimer

This is an **unofficial**, community-driven project. It is **not affiliated with, endorsed by, or connected to COROS** in any way. For an official, COROS-supported MCP server, see [coroslab/COROS-MCP](https://github.com/coroslab/COROS-MCP).

This server communicates with the COROS Training Hub using a **reverse-engineered, undocumented API** that may change or break without notice. Use it at your own risk.

COROS is a trademark of COROS Wearables, Inc. This project is provided as-is with no warranty — see [LICENSE](LICENSE) for details.

## Setup

```bash
cd coros-workout-mcp
npm install
npm run build
```

## Usage with Claude Code

```bash
claude mcp add coros-workout -- node /path/to/coros-workout-mcp/dist/src/index.js
```

To use env var auth (avoids typing credentials in conversation):

```bash
claude mcp add coros-workout -e COROS_EMAIL=you@example.com -e COROS_PASSWORD=yourpass -e COROS_REGION=eu -- node /path/to/coros-workout-mcp/dist/src/index.js
```

## Usage with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "coros-workout": {
      "command": "/path/to/node",
      "args": ["/path/to/coros-workout-mcp/dist/src/index.js"],
      "env": {
        "COROS_EMAIL": "you@example.com",
        "COROS_PASSWORD": "yourpass",
        "COROS_REGION": "eu"
      }
    }
  }
}
```

> **Node.js 18+ required** — this server uses native `fetch()` which was added in Node 18.

> **Troubleshooting `fetch is not defined`:** Claude Desktop is a GUI app that doesn't inherit your shell PATH, so node binaries installed via version managers (mise, nvm, fnm, volta) won't be found. Use the full absolute path to your node binary in `"command"`:
>
> ```bash
> which node        # e.g. /Users/you/.mise/shims/node
> node --version    # confirm it's 18+
> ```
>
> Common locations:
> - **mise**: `~/.local/share/mise/installs/node/<version>/bin/node`
> - **nvm**: `~/.nvm/versions/node/<version>/bin/node`
> - **fnm**: `~/.local/share/fnm/node-versions/<version>/installation/bin/node`
> - **Homebrew**: `/opt/homebrew/bin/node`

## What's supported

| Capability | Status |
|------------|--------|
| Strength workouts (`sportType 4`) | ✅ Full exercise catalog (~383 exercises), sets/reps/duration/weight/rest |
| Running workouts (`sportType 1`) | ✅ Warm-up, work, recovery, cool-down segments; distance or duration targets; pace ranges; repeat groups |
| Listing existing workouts | ✅ |
| Refreshing the exercise catalog | ✅ |
| Scheduling a workout to a date | ✅ Put a saved workout on a calendar day; list what's scheduled in a range |
| Removing a scheduled workout | ❌ Delete endpoint not yet captured — remove it in Training Hub |
| **Multi-week training plans** | ❌ `/training/plan/query` responds, but no create/write support |
| Cycling / swimming workouts | ❌ Encodings not verified |

## Tools

| Tool | Description |
|------|-------------|
| `authenticate_coros` | Log in with email/password (or auto-login from env vars) |
| `check_coros_auth` | Verify current auth status |
| `search_exercises` | Search ~383 exercises by name, muscle, body part, equipment |
| `create_workout` | Build and push a strength workout to COROS |
| `create_run_workout` | Build and push a structured running workout (intervals, tempo, fartlek, easy) |
| `schedule_workout` | Put a saved workout on a calendar date |
| `list_scheduled_workouts` | List workouts scheduled between two dates |
| `update_exercises` | Fetch the latest exercise catalog from COROS and rebuild locally |
| `list_workouts` | List existing workouts |

## Example conversation

> "Search for chest exercises with bodyweight"
>
> "Create a workout called 'Quick Push' with 4x15 Push-ups, 3x10 Diamond Push-ups, and 3x20 Decline Push-ups with 45s rest"
>
> "Build me a 5x800m interval session: 2km warm-up at 6:30-7:00, 800m reps at 4:35-4:50 with 2:30 jog recovery, 2km cool-down"
>
> "Read tomorrow's run from my calendar and create the matching COROS workout"
>
> "Schedule workout 1234567890123456789 on 2026-09-08"
>
> "What have I got scheduled next week?"

## Running workouts

A running workout is an ordered list of **steps**. Each step is a segment with a
target and a pace range, or a `repeat` group wrapping other steps.

| Field | Meaning |
|-------|---------|
| `type` | `warmup`, `work`, `recovery`, `cooldown`, or `repeat` |
| `distanceM` | Distance target in metres — use this **or** `durationSec`, not both |
| `durationSec` | Duration target in seconds |
| `paceFrom` / `paceTo` | Pace range bounds as `mm:ss` per km; order doesn't matter |
| `times` | (`repeat` only) how many times to repeat its `steps` |

Repeats cannot be nested — that's an API limitation, not ours.

**5×800m intervals:**

```json
{
  "name": "Intervals 5x800m",
  "steps": [
    { "type": "warmup", "distanceM": 2000, "paceFrom": "6:30", "paceTo": "7:00" },
    { "type": "repeat", "times": 5, "steps": [
        { "type": "work",     "distanceM": 800,   "paceFrom": "4:35", "paceTo": "4:50" },
        { "type": "recovery", "durationSec": 150, "paceFrom": "7:00", "paceTo": "7:30" }
    ]},
    { "type": "cooldown", "distanceM": 2000, "paceFrom": "6:30", "paceTo": "7:30" }
  ]
}
```

**10km tempo run** — no repeat group needed:

```json
{
  "name": "10km Tempo",
  "steps": [
    { "type": "warmup",   "distanceM": 2000, "paceFrom": "6:30", "paceTo": "7:00" },
    { "type": "work",     "distanceM": 6000, "paceFrom": "5:20", "paceTo": "5:30" },
    { "type": "cooldown", "distanceM": 2000, "paceFrom": "6:30", "paceTo": "7:30" }
  ]
}
```

You rarely need to write this by hand — describe the session in plain language and
Claude fills it in. See the encoding notes in [CLAUDE.md](CLAUDE.md#running-workout-encoding)
if you're working on the internals.

## Scheduling

Creating a workout puts it in your library. `schedule_workout` additionally pins it
to a date so it shows up on that day in Training Hub and syncs to the watch:

```
schedule_workout(workoutId: "1234567890123456789", date: "2026-09-08")
```

Scheduling one day leaves the rest of the plan untouched. To move a workout, schedule
it on the new date and remove the old entry in Training Hub — there's no delete tool
yet.

## Updating the exercise catalog

The bundled exercise catalog (`data/exercises.json`) is a static snapshot. If COROS adds new exercises, use the `update_exercises` tool to refresh it. This fetches the latest exercises from the COROS API and i18n strings from the CDN, rebuilds the catalog, and reloads the in-memory cache — all in a single tool call. Requires authentication.

## Auth notes

- **Region**: `eu` (Europe) or `us` (US). Defaults to `eu`.
- **Credentials** come from `COROS_EMAIL` / `COROS_PASSWORD` / `COROS_REGION`, read from
  the environment or from a `.env` file at the project root. Real environment variables
  win, so an MCP host's `env` block overrides the file. `.env` is gitignored — keep it
  mode 0600.
- **Session conflict**: Logging in via this API invalidates your COROS web app session,
  and vice versa. When the stored token is rejected, the server logs in again from those
  credentials and retries automatically, so a web login only costs one extra round-trip.
  Without credentials configured you'll need to call `authenticate_coros` again by hand.
- Auth tokens are stored at `~/.config/coros-workout-mcp/auth.json` (mode 0600).

## Development

```bash
npm test           # Run unit tests
npm run test:watch # Watch mode
npm run build      # Compile TypeScript
```
