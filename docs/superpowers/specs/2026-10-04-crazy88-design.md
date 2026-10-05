# Crazy 88 Game Platform — Technical Design

**Date:** 2026-10-04  
**Author:** Jorn van der Maat  
**Status:** Implemented (see README.md for the current behaviour)  
**Duration:** 1-hour game session, single deployment per game

> **As built — differences from this design.** The implementation follows the original requirements where this document drifted from them:
> - **Storage:** SQLite + photos on the instance disk instead of PostgreSQL + S3 (a single short game doesn't need either).
> - **Team login:** one shared `TEAM_CODE` plus a team name chosen at login (re-entering the same name rejoins the team), instead of a code per team.
> - **Scores:** a team's own score is live; other teams' scores are revealed every 5 minutes (not pushed instantly).
> - **Scoring rules:** a team earns a normal prompt's points once; while a photo is pending they can't upload another for that prompt; an approved exclusive photo auto-rejects the other teams' pending photos for it.
> - **Ending:** the game has a set duration; the admin's End button shortens it to 5 minutes remaining (never extends it).
> - **Admin can review** using the same swipe screen as reviewers.
> - **Frontend:** plain HTML/JS modules with no build step, instead of React. Socket.io sends "something changed" events and pages refetch over REST.
>
> The sections below are the original design and are kept for reference.

---

## 1. System Overview

**Crazy 88** is a real-time, team-based photo scavenger hunt game where:
- Teams compete to photograph prompts and earn points
- Reviewers approve/reject submissions in real-time
- Special "exclusive" prompts can only be claimed by one team (first approved wins the points, locks others out)
- Admin controls game timing, sets point goals, and manages the session
- All scores update in real-time (pushed via WebSocket) for live tension

**Constraints:**
- 4–5 teams, 3 reviewers, 1 admin
- ~50 prompts (mix of normal and exclusive)
- 1-hour game session (admin-configurable duration)
- Single EC2 instance deployment (session torn down after game ends)
- Mobile-first photo uploads from team phones

---

## 2. Architecture & Tech Stack

### Components

```
┌─────────────────────────────────────────────────────┐
│                    AWS EC2 Instance                 │
│  ┌──────────────────────────────────────────────┐  │
│  │           Node.js Express Backend            │  │
│  │  ┌─────────────────────────────────────────┐ │  │
│  │  │  REST API (login, submit, get state)   │ │  │
│  │  │  WebSocket Server (real-time updates)   │ │  │
│  │  │  Game State Manager (timers, locks)     │ │  │
│  │  │  Review Queue Manager (per-reviewer)    │ │  │
│  │  └─────────────────────────────────────────┘ │  │
│  │                      ↓                        │  │
│  │  ┌─────────────────────────────────────────┐ │  │
│  │  │         PostgreSQL Database             │ │  │
│  │  │  (teams, photos, prompts, approvals)   │ │  │
│  │  └─────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────┘  │
│                      ↓                              │
│  ┌──────────────────────────────────────────────┐  │
│  │          AWS S3 Bucket (Photos)             │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Client Applications (React)             │
├─────────────────────────────────────────────────────┤
│  Team App      │  Admin Panel   │  Reviewer App     │
│  (mobile-      │  (web/desktop) │  (web/desktop)    │
│   friendly)    │                │                   │
└─────────────────────────────────────────────────────┘
```

### Tech Choices

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Backend** | Node.js + Express | Lightweight, great WebSocket support, fast to deploy |
| **Real-time** | Socket.io or native WebSocket | Handles 4–5 concurrent clients easily, simple state sync |
| **Database** | PostgreSQL | Relational data (teams, photos, prompts); ACID guarantees for approval workflow |
| **Photo Storage** | AWS S3 | Scalable, durable; EC2 has IAM role access, no key management needed |
| **Frontend** | React | Responsive, real-time state updates with WebSocket |
| **Deployment** | Single EC2 instance (t3.medium) | Plenty for 4–5 teams; no scaling needed for 1-hour session |

---

## 3. Data Model

### Core Tables

#### **teams**
```sql
id (UUID, PK)
name (VARCHAR)
login_code (VARCHAR, unique)
players (TEXT array or JSON) -- ["Player 1", "Player 2", ...]
score (INT, default 0)
joined_at (TIMESTAMP)
```

#### **prompts**
```sql
id (UUID, PK)
text (VARCHAR)
points (INT)
is_exclusive (BOOLEAN) -- TRUE = only one team can claim; FALSE = all teams can earn points
claimed_by_team_id (UUID, nullable) -- NULL until a team's photo is approved on exclusive prompt
sort_order (INT) -- display order in team UI
created_at (TIMESTAMP)
```

#### **photos**
```sql
id (UUID, PK)
team_id (UUID, FK → teams)
prompt_id (UUID, FK → prompts)
s3_url (VARCHAR)
s3_key (VARCHAR) -- for deletion if needed
uploaded_at (TIMESTAMP)
status (ENUM: 'pending', 'approved', 'rejected')
approved_by_reviewer_id (UUID, nullable, FK → reviewers)
approved_at (TIMESTAMP, nullable)
display_order (INT) -- which upload attempt is this? (1st, 2nd, 3rd...)
```

#### **reviewers**
```sql
id (UUID, PK)
login_code (VARCHAR, unique)
name (VARCHAR)
joined_at (TIMESTAMP)
```

#### **game_session**
```sql
id (UUID, PK)
admin_code (VARCHAR, unique)
status (ENUM: 'waiting', 'active', 'countdown', 'ended')
started_at (TIMESTAMP, nullable)
duration_seconds (INT) -- admin sets this (e.g., 3600 for 1 hour)
goal_points (INT) -- admin sets the progress bar target
countdown_start (TIMESTAMP, nullable) -- when admin clicks "end game"
ended_at (TIMESTAMP, nullable)
```

### Key Constraints & Indexes

- **photos.team_id, photos.prompt_id** → unique constraint (only latest upload per team per prompt tracked; previous rejected ones kept for history)
  - Actually: no unique constraint needed; allow multiple uploads per team per prompt, track all with `display_order`
- **photos.status** → index (reviewers query pending photos frequently)
- **game_session.status** → indexed (check game state on every request)
- **prompts.is_exclusive + prompts.claimed_by_team_id** → determine if a prompt is still available

---

## 4. Authentication & Session Management

### Login Flow (No Password)

**Team Login:**
1. Team enters **team name** + **team code** (e.g., "Blue Team", "CODE-1234")
2. Backend validates code exists in database, creates/reuses a session token (JWT or opaque token)
3. Token stored in browser localStorage, sent in every API request + WebSocket handshake
4. Session expires at game end (admin-triggered) or after 24 hours (safeguard)

**Admin Login:**
1. Admin enters **admin code** (e.g., "ADMIN-5678")
2. Same token flow, admin interface unlocked

**Reviewer Login:**
1. Reviewer enters **reviewer code** (e.g., "REV-9999")
2. Same token flow, reviewer interface unlocked

### Session Storage

Sessions stored in-memory (Node.js process) or in Redis if horizontal scaling needed (not needed for this 1-hour single-instance game, but OK to plan for future).

```javascript
// In-memory session map (simple version)
const sessions = new Map(); // session_token → {user_id, role, expires_at}
```

Token validation on every WebSocket message and HTTP request.

---

## 5. Photo Upload & Approval Workflow

### Team Upload Flow

1. **Team selects prompt** from list, opens camera or file picker
2. **Client-side compression:**
   - Resize image to max 1280x1280 (covers most phone screens)
   - Compress to JPEG with 80% quality
   - Max 2MB final size
3. **POST /api/photos** (multipart form-data)
   - Headers: Authorization token
   - Body: prompt_id, image file
   - Backend receives image, uploads to S3 with key: `{game_session_id}/{team_id}/{prompt_id}/{timestamp}.jpg`
   - Database record created with status='pending'
4. **WebSocket broadcast** (to all reviewers):
   - New photo in queue for reviewer
   - Includes: team name, team members, prompt text, photo thumbnail URL

### Reviewer Approval Flow

1. **Reviewer sees queue** of pending photos (independent queue per reviewer, no shared queue)
2. **Reviewer's local queue** = all photos with status='pending' assigned to this reviewer
   - Assignment: round-robin or first-come-first-served (design choice: round-robin for fairness)
3. **Reviewer swipes right (approve) or left (reject):**
   - POST /api/photos/{photo_id}/approve or /reject
   - Backend updates photo.status
4. **On approval:**
   - If prompt is exclusive:
     - Check if already claimed by another team
     - If not claimed: set `prompts.claimed_by_team_id = this_team_id` (lock it)
     - If already claimed: reject the photo (should not happen in ideal flow, but safeguard)
   - Add points to team.score
   - WebSocket broadcast to all teams: score update + this team's new score
5. **On rejection:**
   - Photo status = 'rejected'
   - Team can re-upload same prompt
   - WebSocket broadcast to reviewer: "Rejected, next photo"

### Concurrent Upload Scenario

**Edge case:** Two teams upload for the same exclusive prompt near-simultaneously, both pending.

**Solution:** 
- Reviewer approves Team A's photo first → prompt is locked to Team A
- When reviewing Team B's photo, backend checks `prompts.claimed_by_team_id` and rejects it automatically (show message to reviewer: "Prompt already claimed by Team A")

---

## 6. Real-time Updates via WebSocket

### WebSocket Events

**Server → Clients:**

| Event | Payload | Sent To |
|-------|---------|---------|
| `score_update` | `{team_id, new_score, all_team_scores}` | All teams |
| `new_photo_in_queue` | `{photo_id, team_name, prompt_text, thumbnail_url}` | Assigned reviewer |
| `photo_approved` | `{photo_id, prompt_name}` | Assigned reviewer (confirmation) |
| `prompt_locked` | `{prompt_id, claimed_by_team_name}` (exclusive only) | All reviewers, optionally all teams |
| `game_started` | `{}` | All clients |
| `countdown_started` | `{seconds_remaining}` | All clients |
| `game_ended` | `{}` | All clients |

**Clients → Server:**
- Approve/reject handled via REST POST for atomic database updates
- WebSocket used only for server-push updates

### Score Update Cadence

**Option A: Push immediately on approval**
- Pros: Real-time tension, instant feedback
- Cons: Spiky updates if lots of approvals

**Option B: Batch push every 5 minutes**
- Pros: Consistent, predictable tension rhythm
- Cons: Delayed gratification

**Recommendation:** Push **immediately** on approval, but also send a batched update every 5 minutes for clients that missed real-time events. This gives best-of-both and handles network failures.

### Connection Management

- WebSocket auto-reconnect if connection drops (client-side)
- On reconnect, client re-syncs game state (fetch latest scores, game status)
- Heartbeat ping/pong every 30 seconds to detect stale connections

---

## 7. Admin Interface & Game Control

### Admin Dashboard

**Before Game Starts:**
- Set game duration (minutes, e.g., 60)
- Set goal points (target for progress bar, e.g., 500)
- View all teams that have logged in
- Edit/add/remove prompts (name, points, exclusive flag)
- Start game button

**During Game:**
- Live scoreboard (all team scores)
- Number of pending photos (global and per-reviewer)
- List of locked exclusive prompts
- End game button

**Countdown Phase (after End button clicked):**
- 5-minute countdown timer displayed
- Teams see countdown, cannot upload new photos
- Reviewers continue reviewing pending photos
- Cannot cancel countdown (design choice for simplicity)

**After Game Ends:**
- Final scores locked
- Admin can view final results
- Teams directed to final gallery view

### Admin API Endpoints

```
POST /api/admin/login
  body: {admin_code}
  → token

POST /api/admin/start-game
  body: {duration_seconds, goal_points}
  → game started, all clients notified

POST /api/admin/end-game
  → countdown started, submissions locked

GET /api/admin/stats
  → {teams: [...], photos_pending, prompts_locked}

POST /api/admin/prompts
  body: {text, points, is_exclusive}
  → new prompt added (before game start only)

DELETE /api/admin/prompts/{prompt_id}
  → delete prompt (before game start only)

PUT /api/admin/prompts/{prompt_id}
  body: {text, points, is_exclusive}
  → update prompt (before game start only)
```

---

## 8. Team Interface & Score Display

### Team App Layout

**Header:** 
- Team name
- Live score
- Progress bar (current_score / goal_points)
- Time remaining (countdown during final 5 minutes)

**Main Content:**
- List of 50 prompts (scrollable)
- Per prompt: text, points, "Upload Photo" button
- Visual indicator if prompt is locked (exclusive + already claimed by another team)
- Visual indicator of own uploads (pending, approved, rejected)

**Bottom Sheet/Modal (on "Upload Photo"):**
- Camera + Gallery picker
- Photo preview before upload
- Submit button
- Show feedback: "Pending review" / "Approved ✓" / "Rejected, try again"

### Team API Endpoints

```
POST /api/teams/login
  body: {name, team_code}
  → token

GET /api/game-state
  → {teams_scores, game_status, time_remaining, goal_points}

GET /api/prompts
  → {prompts: [...], locked_prompts_by_team}

POST /api/photos
  body: {prompt_id, image_file}
  → {photo_id, status}

GET /api/teams/{team_id}/photos
  → list of photos uploaded by this team with statuses

GET /api/team-scores
  → {team_id, score, rank, all_scores}
```

---

## 9. Reviewer Interface & Queue

### Reviewer App Layout

**Header:**
- Reviewer name
- Total photos reviewed (approved + rejected)
- Game time remaining

**Main Content: Swipe Card**
- Large photo display
- Above: Team name, team members (names), prompt text, upload timestamp
- Below: **Approve** (right/thumbs-up) and **Reject** (left/thumbs-down) buttons
- Swipe gesture support (optional enhancement)
- "No more photos" screen when queue is empty

**Stats Panel:**
- Pending photos in queue (just this reviewer's queue)
- Locked prompts (global view)

### Reviewer API Endpoints

```
POST /api/reviewers/login
  body: {reviewer_code}
  → token

GET /api/reviewers/queue
  → {photos: [pending_photos_assigned_to_me]}

POST /api/photos/{photo_id}/approve
  → {status: 'approved', new_team_score}
  → WebSocket broadcast to teams

POST /api/photos/{photo_id}/reject
  → {status: 'rejected'}
  → WebSocket notification to reviewer (next photo)

GET /api/game-state
  → {game_status, locked_prompts, all_team_scores}
```

---

## 10. Final Gallery View

### Timing
- **Shown after:** Admin clicks end game → 5-minute countdown completes → game_status = 'ended'
- **Accessibility:** Teams directed to gallery automatically, or access via link

### Gallery Layout

**Header:**
- Final scores (ranked list of teams)
- "Winning photos" badge for exclusive prompt winners

**Main Content: Organized by Prompt**
- For each prompt (in order):
  - Prompt text, points, total uploads
  - Grid of photos (approved, rejected, pending all shown)
  - Visual labels: "✓ Approved", "✗ Rejected", "⏳ Pending"
  - For exclusive prompts: highlight the winning photo + team name

### Gallery API Endpoints

```
GET /api/gallery
  → {prompts: [...], photos_by_prompt, final_scores, game_stats}

GET /api/photos/{photo_id}
  → full-resolution photo (or S3 presigned URL redirect)
```

---

## 11. Deployment & Infrastructure

### EC2 Setup

1. **Instance:** t3.medium (2 CPU, 4GB RAM) — more than enough for 4–5 concurrent teams
2. **OS:** Amazon Linux 2 or Ubuntu 22.04
3. **Node.js:** v18 LTS or later
4. **PM2 or systemd:** Simple process manager for the app

### Database

- **PostgreSQL 14+** on the same EC2 instance (or RDS for production resilience, overkill for 1-hour session)
- Initialize schema from migration scripts before game starts
- No data retention needed; delete all after game session

### S3 Setup

- **Bucket:** `crazy88-photos-{date}` (or reusable `crazy88-photos`)
- **IAM Role:** EC2 instance has role `CrazyEightPhotosUploadRole` with:
  - `s3:PutObject` on bucket
  - `s3:DeleteObject` (for cleanup)
- **Lifecycle Policy:** Delete all photos after 7 days (safety net)
- **CORS:** Allow uploads from EC2 domain

### Environment Variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/crazy88
AWS_REGION=us-east-1
S3_BUCKET=crazy88-photos
NODE_ENV=production
PORT=3000
JWT_SECRET=<random-secret>
```

### Startup Script

```bash
#!/bin/bash
# 1. Install dependencies
npm install

# 2. Run database migrations
npm run migrate

# 3. Seed prompts from JSON file (admin can customize)
npm run seed-prompts

# 4. Start server
npm start
```

### Teardown

After game ends:
```bash
# Stop server
pm2 stop app

# Delete database
dropdb crazy88

# Clear S3 bucket
aws s3 rm s3://crazy88-photos --recursive

# Optional: Stop EC2 instance
aws ec2 stop-instances --instance-ids i-xxx
```

---

## 12. Error Handling & Edge Cases

### Network Failures

**Team loses connection:**
- WebSocket auto-reconnect on client
- On reconnect, fetch latest game state, scores, and pending photos
- Uploads in progress: client-side retry with exponential backoff

**Reviewer loses connection:**
- Same auto-reconnect
- Queue state re-synced (fetch pending photos again)

### Concurrent Submissions

**Two teams upload for exclusive prompt simultaneously:**
1. Both photos enter as pending
2. Reviewer approves one first → prompt locked
3. When reviewer sees the other photo, backend rejects it automatically (with message: "Prompt already claimed")
4. Reviewer sees this as already-handled (greyed out or hidden)

### Malformed/Oversized Photos

- Client-side validation (size < 2MB, format JPEG/PNG)
- Server-side re-validate
- If invalid: return 400 error with message "Image too large" or "Invalid format"

### Reviewer Approval Takes Too Long

- If review queue is backed up, game time runs out while photos are pending
- Pending photos remain pending in final gallery (shown as "⏳ Pending")
- Points not awarded for pending photos

### Clock Skew

- Admin sets countdown from server time
- Clients poll `/api/game-state` every 5 seconds to verify remaining time
- If client clock is way off, server time is source of truth

### Database Connection Loss

- Auto-reconnect with exponential backoff
- During connection loss, new API requests fail with 503
- Clients show "Connection lost, retrying..." message

---

## 13. Testing Strategy

### Unit Tests

- Prompt lock logic (exclusive prompts)
- Score calculation (normal vs. exclusive points)
- Photo queue assignment (round-robin to reviewers)
- JWT token validation and expiry

### Integration Tests

- Full team login → upload → reviewer approve → score broadcast flow
- Concurrent exclusive prompt claims (only one team gets points)
- Admin end game → 5-min countdown → auto-lock submissions
- Final gallery data assembly (correct photos, correct labels)

### Load Testing

- Simulate 5 teams uploading photos every 2–3 seconds over 60 minutes
- 3 reviewers processing queue
- WebSocket broadcast to all clients every 5 minutes
- Verify server memory usage, database connection pool, S3 upload success

### Manual Testing Checklist

- [ ] Team login with code
- [ ] Admin login, start game (set duration, goal)
- [ ] Team uploads photo, see "Pending review"
- [ ] Reviewer sees photo in queue, approves
- [ ] Team score updates in real-time (WebSocket)
- [ ] Exclusive prompt locked after first approval
- [ ] Admin clicks "End Game", 5-min countdown starts
- [ ] No new uploads allowed during countdown
- [ ] Pending reviews processed during countdown
- [ ] Game ends, final gallery shows all photos
- [ ] Network disconnect → reconnect → state re-synced

---

## 14. API Endpoint Reference

### Authentication

```
POST /api/teams/login
POST /api/admin/login
POST /api/reviewers/login
```

### Game Management (Admin)

```
POST /api/admin/start-game
POST /api/admin/end-game
GET /api/admin/stats
POST /api/admin/prompts
DELETE /api/admin/prompts/{prompt_id}
PUT /api/admin/prompts/{prompt_id}
```

### Game State (All Roles)

```
GET /api/game-state
GET /api/prompts
GET /api/team-scores
```

### Photos (Teams)

```
POST /api/photos (upload)
GET /api/teams/{team_id}/photos
```

### Photos (Reviewers)

```
GET /api/reviewers/queue
POST /api/photos/{photo_id}/approve
POST /api/photos/{photo_id}/reject
```

### Gallery (All Roles)

```
GET /api/gallery
GET /api/photos/{photo_id}
```

---

## 15. Summary of Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Real-time | WebSocket | Live score tension, immediate approval feedback |
| Database | PostgreSQL | Relational, ACID for approval workflow, easy to set up on EC2 |
| Photo Storage | AWS S3 | Durable, scalable, EC2 has native IAM access |
| Auth | Code-based (no password) | Simple, no user management overhead for 1-hour session |
| Admin Can | Customize prompts, set duration/goal, manually trigger end | Full control over game parameters and pacing |
| Reviewer Queue | Independent per reviewer | Avoids conflict, simple assignment logic |
| Countdown | 5 minutes, cannot cancel | Simple, gives teams/reviewers time to wrap up |
| Final Gallery | Shows all photos (approved, rejected, pending) | Transparency, fun to see attempt photos |
| Exclusive Prompt | Locked after first approval, cannot re-claim | Creates real competition tension |

---

## 16. Future Enhancements (Out of Scope)

- Multi-game sessions (run multiple games sequentially)
- Persistent data analytics (track game stats, team performance)
- Photo filters/effects before upload
- Swipe gesture on reviewer app (web-based, not mobile app)
- Real-time team notifications ("Team B just got 50 points!")
- Leaderboard animations (celebration effects)
- Admin can pause/resume game

---

**End of Design Document**
