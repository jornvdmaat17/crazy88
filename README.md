# Crazy 88

A photo game for one evening. Teams photograph prompts on their phones, reviewers swipe to approve or reject, and the first team to get an approved photo on an exclusive prompt claims its points. When the game ends, everyone can see everyone's photos.

## Roles and codes

Everyone logs in on the same page with a code. There are no accounts.

| Code (env var) | Who | What they can do |
|---|---|---|
| `TEAM_CODE` | Each team (one phone per team) | Enter the code plus a team name. Logging in again with the same name rejoins that team. |
| `REVIEWER_CODE` | Reviewers | Swipe through photos waiting for review. Each reviewer gets their own photos. |
| `ADMIN_CODE` | Admin | Manage prompts, set the duration and point goal, start and end the game. Can also review. |

Logins last 3 days. Codes are case-insensitive.

## How a game runs

1. **Lobby.** Admin adds prompts. Bulk add takes `points | text`; start a line with `!` to make it exclusive. Admin sets the duration and the goal, then watches teams join.
2. **Start.** Admin presses Start. Teams see all prompts and the timer.
3. **Play.** Teams upload photos, which are compressed on the phone first. A team can't upload again for a prompt while its photo is in review. After a rejection they can retry. Once approved, the prompt is done for that team.
   - **Normal prompts:** every team can earn the points.
   - **Exclusive prompts:** the first approved photo claims the prompt. Other teams' pending photos for it are rejected automatically and the prompt locks.
   - Each team sees its own score live. Other teams' scores refresh every N minutes; the admin sets N (default 5). With N = 0, other teams' scores stay hidden until the game ends.
   - The progress bar shows the goal, with markers for the other teams. A goal of 0 turns the goal and the bar off.
4. **End.** Admin presses End game, which gives 5 more minutes (or less if the timer is already lower). When time runs out, uploads close and reviewers finish the queue.
5. **Gallery.** After the end, everyone sees all photos per prompt: approved, rejected and pending, with the exclusive winners highlighted. It updates live while the last reviews come in.

## Run locally

```bash
npm install
TEAM_CODE=TEAM REVIEWER_CODE=JUDGE ADMIN_CODE=BOSS npm start
# open http://localhost:3000
npm test   # game rule tests
```

## Deploy on EC2

Photos are stored on the instance's disk under `DATA_DIR/uploads` (about 300 KB each after compression). The data lives in a SQLite file in `DATA_DIR`. For one game with ~5 teams, that is a few hundred MB at most, so S3 isn't needed.

It runs with Docker Compose as two containers: the app, and a Cloudflare tunnel (`cloudflared`) that serves it over HTTPS on your domain. No inbound ports need to be opened. The app is also available on the instance itself at `127.0.0.1:8095` for debugging. Change `APP_PORT` in `.env` if that port is taken.

1. **Create a tunnel.** In Cloudflare Zero Trust, go to Networks → Tunnels and create a tunnel. Copy its token. Add a public hostname (e.g. `crazy88.example.com`) with service type `HTTP` and URL `app:3000`.
2. **Copy the project** to the instance (git clone or scp), then `cd` into it.
3. **Config.** Run `cp deploy/crazy88.env.example .env`. In `.env`, set your own codes and `TUNNEL_TOKEN`.
4. **Start:**
   ```bash
   docker compose up -d --build
   docker compose logs -f tunnel   # should show "Registered tunnel connection"
   ```
   Open `https://<your hostname>`.

The compose project is named `crazy88`, so its containers, network and volumes don't clash with other stacks on the same machine.

Photos and the database live in the `crazy88-data` Docker volume. That volume survives container restarts and rebuilds, so the timer, scores and logins carry on if anything restarts mid-game.

**Afterwards:** copy the photos out if you want to keep them, then terminate the instance:
```bash
docker compose cp app:/data/uploads ./photos
```

**Practice run:** press **Reset game** on the admin page. It goes back to the lobby, keeps prompts and settings, and deletes teams, photos and scores. Teams have to log in again. To wipe everything including prompts, run `docker compose down -v`, then `docker compose up -d`.

**Without Docker:** install Node 20+ and run `npm ci --omit=dev && npm start` with the variables from `.env` set. Put any HTTPS reverse proxy in front of port 3000.
