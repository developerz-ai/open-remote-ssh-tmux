# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: what the bot triages, closes, reviews and merges. [Reference](https://developerz.ai/docs/maintainer-yml) |
| `schedules/release-due.md` | `schedules: release-due`, Monday 07:00 UTC, read-only: the weekly release judgement. Files an ask; changes nothing |
| `schedules/maintain.md` | `schedules: maintain`, Monday 08:00 UTC, devops task: the local gate on fresh `main`, a new tmux release into the rig matrix, tool pins Dependabot cannot see, docs truth. At most one pull request per run |

Each brief is read at `main`'s HEAD when its schedule fires. Security updates do not wait for Monday: Dependabot's `*-security` groups (`.github/dependabot.yml`) open them as advisories land.
