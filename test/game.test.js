const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createGame, ENDGAME_MS } = require('../server/game');

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const game = createGame(openDb(':memory:'), { now: clock.now });
  game.addPrompts([
    { text: 'Normal', points: 10, exclusive: false },
    { text: 'Special', points: 50, exclusive: true },
  ]);
  const [normal, special] = game.prompts();
  const a = game.joinTeam('Alpha');
  const b = game.joinTeam('Bravo');
  return { game, clock, normal, special, a, b };
}

test('uploads are blocked before the game starts', () => {
  const { game, a, normal } = setup();
  assert.throws(() => game.addPhoto(a.id, normal.id, 'x.jpg'), /not started/);
});

test('rejoining with the same name (any case) returns the same team', () => {
  const { game, a } = setup();
  assert.equal(game.joinTeam('  alpha ').id, a.id);
});

test('normal prompts score for every team that gets approved', () => {
  const { game, a, b, normal } = setup();
  game.start();
  const pa = game.addPhoto(a.id, normal.id, 'a.jpg');
  const pb = game.addPhoto(b.id, normal.id, 'b.jpg');
  game.decide(pa, true, 'r1');
  game.decide(pb, true, 'r1');
  const scores = Object.fromEntries(game.liveScores().map((s) => [s.name, s.score]));
  assert.deepEqual(scores, { Alpha: 10, Bravo: 10 });
});

test('a team cannot upload again while pending or after approval, but can after rejection', () => {
  const { game, a, normal } = setup();
  game.start();
  const p1 = game.addPhoto(a.id, normal.id, '1.jpg');
  assert.throws(() => game.addPhoto(a.id, normal.id, '2.jpg'), /still being reviewed/);
  game.decide(p1, false, 'r1');
  const p2 = game.addPhoto(a.id, normal.id, '2.jpg');
  game.decide(p2, true, 'r1');
  assert.throws(() => game.addPhoto(a.id, normal.id, '3.jpg'), /already completed/);
  assert.equal(game.liveScores().find((s) => s.name === 'Alpha').score, 10);
});

test('exclusive prompt: first approval claims it and auto-rejects other pending photos', () => {
  const { game, a, b, special } = setup();
  game.start();
  const pa = game.addPhoto(a.id, special.id, 'a.jpg');
  const pb = game.addPhoto(b.id, special.id, 'b.jpg');
  const res = game.decide(pa, true, 'r1');
  assert.deepEqual(res.autoRejectedTeamIds, [b.id]);
  assert.equal(game.getPhoto(pb).status, 'rejected');
  assert.match(game.getPhoto(pb).reject_reason, /Claimed by Alpha/);
  assert.throws(() => game.decide(pb, true, 'r2'), /already reviewed/);
  assert.throws(() => game.addPhoto(b.id, special.id, 'b2.jpg'), /Already claimed by Alpha/);
  assert.equal(game.prompts().find((p) => p.id === special.id).claimed_by, 'Alpha');
  assert.equal(game.liveScores().find((s) => s.name === 'Bravo').score, 0);
});

test('reviewers get different photos; stale assignments are handed out again', () => {
  const { game, clock, a, b, normal } = setup();
  game.start();
  const pa = game.addPhoto(a.id, normal.id, 'a.jpg');
  clock.advance(1);
  const pb = game.addPhoto(b.id, normal.id, 'b.jpg');
  assert.equal(game.nextForReviewer('r1').id, pa);
  assert.equal(game.nextForReviewer('r1').id, pa, 'same reviewer keeps their photo');
  assert.equal(game.nextForReviewer('r2').id, pb);
  assert.equal(game.nextForReviewer('r3'), null);
  clock.advance(3 * 60 * 1000);
  assert.equal(game.nextForReviewer('r3').id, pa);
});

test('ending gives 5 minutes, then uploads stop but reviews continue', () => {
  const { game, clock, a, b, normal } = setup();
  game.start();
  const pa = game.addPhoto(a.id, normal.id, 'a.jpg');
  game.triggerEnd();
  assert.equal(game.phase(), 'ending');
  assert.throws(() => game.triggerEnd(), /already ending/);
  clock.advance(ENDGAME_MS - 1);
  game.addPhoto(b.id, normal.id, 'b.jpg');
  clock.advance(1);
  assert.equal(game.phase(), 'ended');
  assert.throws(() => game.addPhoto(a.id, normal.id, 'late.jpg'), /game is over/);
  assert.equal(game.decide(pa, true, 'r1').status, 'approved');
});

test('end button never extends a game that has less than 5 minutes left', () => {
  const { game, clock } = setup();
  game.updateSettings({ durationMin: 10 });
  game.start();
  const endsAt = game.state().endsAt;
  clock.advance(8 * 60 * 1000);
  game.triggerEnd();
  assert.equal(game.state().endsAt, endsAt);
});

test('team scoreboard only refreshes every N minutes during the game (default 5)', () => {
  const { game, clock, a, normal } = setup();
  game.start();
  game.tick();
  game.decide(game.addPhoto(a.id, normal.id, 'a.jpg'), true, 'r1');
  const alpha = () => game.scoreboard().scores.find((s) => s.name === 'Alpha').score;
  assert.equal(alpha(), 0, 'hidden until next snapshot');
  assert.equal(game.teamView(a.id).score, 10, 'own score is live');
  clock.advance(4 * 60 * 1000);
  assert.equal(game.tick().scoreboard, false);
  clock.advance(60 * 1000);
  assert.equal(game.tick().scoreboard, true);
  assert.equal(alpha(), 10);
});

test('score interval can be changed to 10 minutes', () => {
  const { game, clock } = setup();
  game.updateSettings({ scoreIntervalMin: 10 });
  game.start();
  game.tick();
  clock.advance(5 * 60 * 1000);
  assert.equal(game.tick().scoreboard, false);
  clock.advance(5 * 60 * 1000);
  assert.equal(game.tick().scoreboard, true);
  assert.equal(game.scoreboard().nextAt - game.scoreboard().at, 10 * 60 * 1000);
});

test('score interval 0 hides other teams until the game ends', () => {
  const { game, clock, a, normal } = setup();
  game.updateSettings({ scoreIntervalMin: 0, durationMin: 10 });
  game.start();
  game.decide(game.addPhoto(a.id, normal.id, 'a.jpg'), true, 'r1');
  clock.advance(6 * 60 * 1000);
  game.tick();
  assert.deepEqual(game.scoreboard(), { scores: [], hidden: true });
  assert.equal(game.teamView(a.id).score, 10);
  clock.advance(4 * 60 * 1000);
  assert.equal(game.scoreboard().scores.find((s) => s.name === 'Alpha').score, 10);
});

test('goal 0 means no goal; negative goal rejected', () => {
  const { game } = setup();
  game.updateSettings({ goalPoints: 0 });
  assert.equal(game.state().goalPoints, 0);
  assert.throws(() => game.updateSettings({ goalPoints: -1 }), /whole number/);
});

test('prompts with photos cannot be deleted; exclusive flag locked after approval', () => {
  const { game, a, special } = setup();
  game.start();
  game.decide(game.addPhoto(a.id, special.id, 'a.jpg'), true, 'r1');
  assert.throws(() => game.deletePrompt(special.id), /already has photos/);
  assert.throws(() => game.updatePrompt(special.id, { text: 'S', points: 5, exclusive: false }), /exclusive flag/);
  game.updatePrompt(special.id, { text: 'Renamed', points: 60, exclusive: true });
  assert.equal(game.liveScores().find((s) => s.name === 'Alpha').score, 60);
});

test('reset returns to the lobby, keeps prompts and settings, removes teams and photos', () => {
  const { game, a, normal } = setup();
  game.updateSettings({ goalPoints: 80 });
  game.createSession('team-token', 'team', a.id);
  game.createSession('admin-token', 'admin');
  game.start();
  game.addPhoto(a.id, normal.id, 'a.jpg');
  game.triggerEnd();
  assert.deepEqual(game.reset(), ['a.jpg']);
  assert.equal(game.phase(), 'lobby');
  assert.equal(game.state().goalPoints, 80);
  assert.equal(game.prompts().length, 2);
  assert.equal(game.teams().length, 0);
  assert.equal(game.pendingCount(), 0);
  assert.equal(game.getSession('team-token', Infinity), null);
  assert.ok(game.getSession('admin-token', Infinity), 'admin stays logged in');
  game.start();
  assert.equal(game.phase(), 'active');
});

test('gallery lists every attempt with its status and exclusive winner', () => {
  const { game, a, b, special } = setup();
  game.start();
  const pb = game.addPhoto(b.id, special.id, 'b.jpg');
  game.decide(pb, false, 'r1');
  game.decide(game.addPhoto(a.id, special.id, 'a.jpg'), true, 'r1');
  const g = game.gallery().prompts.find((p) => p.id === special.id);
  assert.equal(g.winner, 'Alpha');
  assert.deepEqual(g.photos.map((p) => [p.team, p.status]), [['Bravo', 'rejected'], ['Alpha', 'approved']]);
});
