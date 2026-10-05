const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createGame, ENDGAME_MS, SNAPSHOT_MS } = require('../server/game');

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

test('team scoreboard only refreshes every 5 minutes during the game', () => {
  const { game, clock, a, normal } = setup();
  game.start();
  game.tick();
  game.decide(game.addPhoto(a.id, normal.id, 'a.jpg'), true, 'r1');
  const alpha = () => game.scoreboard().scores.find((s) => s.name === 'Alpha').score;
  assert.equal(alpha(), 0, 'hidden until next snapshot');
  assert.equal(game.teamView(a.id).score, 10, 'own score is live');
  clock.advance(SNAPSHOT_MS);
  assert.equal(game.tick().scoreboard, true);
  assert.equal(alpha(), 10);
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
