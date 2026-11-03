import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../lib/trips.js';
import * as client from '../../client/src/lib/trips.js';

// One case table, two shapes: the server reads decoded rows (snake_case), the client
// reads the GET /api/trips payload (camelCase). Both must pick the same row.
const toServer = (r) => ({
  id: r.id,
  start_date: r.start,
  end_date: r.end,
  created_at: r.created,
  archived_at: r.archived ?? null,
});
const toClient = (r) => ({
  id: r.id,
  startDate: r.start,
  endDate: r.end,
  createdAt: r.created,
  archivedAt: r.archived ?? null,
});

const ROWS = {
  rome: { id: 'rome', start: '2026-10-12', end: '2026-10-15', created: '2026-10-01T10:00:00Z' },
  milan: { id: 'milan', start: '2026-10-15', end: '2026-10-19', created: '2026-10-01T10:00:00Z' },
  pompeii: { id: 'pompeii', start: '2026-10-14', end: '2026-10-14', created: '2026-10-02T10:00:00Z' },
  long: { id: 'long', start: '2026-10-12', end: '2026-10-30', created: '2026-09-01T10:00:00Z' },
  older: { id: 'older', start: '2026-11-01', end: '2026-11-02', created: '2026-09-01T10:00:00.100000+00:00' },
  newer: { id: 'a-newer', start: '2026-11-01', end: '2026-11-02', created: '2026-09-02T10:00:00.100000+00:00' },
  twinA: { id: 'twin-a', start: '2026-12-01', end: '2026-12-02', created: '2026-09-01T10:00:00Z' },
  twinB: { id: 'twin-b', start: '2026-12-01', end: '2026-12-02', created: '2026-09-01T10:00:00Z' },
  noCreated: { id: 'no-created', start: '2027-01-01', end: '2027-01-02' },
  archived: { id: 'archived', start: '2026-10-12', end: '2026-10-15', created: '2026-09-01T10:00:00Z', archived: '2026-10-20T00:00:00Z' },
};

const CASES = [
  { name: 'first day of a stop', rows: ['rome'], date: '2026-10-12', want: 'rome' },
  { name: 'last day of a stop', rows: ['rome'], date: '2026-10-15', want: 'rome' },
  { name: 'the day before and after match nothing', rows: ['rome'], date: '2026-10-11', want: null },
  { name: 'the day after matches nothing', rows: ['rome'], date: '2026-10-16', want: null },
  { name: 'a shared travel day goes to the later start', rows: ['rome', 'milan'], date: '2026-10-15', want: 'milan' },
  { name: 'a day trip inside a stop wins', rows: ['rome', 'pompeii'], date: '2026-10-14', want: 'pompeii' },
  { name: 'equal starts: the shorter span wins', rows: ['long', 'rome'], date: '2026-10-13', want: 'rome' },
  { name: 'same dates: the earliest created wins, whatever the id', rows: ['newer', 'older'], date: '2026-11-01', want: 'older' },
  { name: 'same everything: the lower id wins', rows: ['twinB', 'twinA'], date: '2026-12-01', want: 'twin-a' },
  { name: 'a missing created date does not throw', rows: ['noCreated'], date: '2027-01-01', want: 'no-created' },
];

for (const c of CASES) {
  test(`parity stopForDate: ${c.name}`, () => {
    const pick = (lib, shape) => lib.stopForDate(c.rows.map((k) => shape(ROWS[k])), c.date)?.id ?? null;
    assert.equal(pick(server, toServer), c.want);
    assert.equal(pick(client, toClient), c.want);
  });

  test(`parity tripForDate: ${c.name}`, () => {
    const pick = (lib, shape) => lib.tripForDate(c.rows.map((k) => shape(ROWS[k])), c.date)?.id ?? null;
    assert.equal(pick(server, toServer), c.want);
    assert.equal(pick(client, toClient), c.want);
  });
}

test('parity tripForDate: archived trips are excluded on both sides', () => {
  const pick = (lib, shape, keys) => lib.tripForDate(keys.map((k) => shape(ROWS[k])), '2026-10-13')?.id ?? null;
  assert.equal(pick(server, toServer, ['archived']), null);
  assert.equal(pick(client, toClient, ['archived']), null);
  assert.equal(pick(server, toServer, ['archived', 'rome']), 'rome');
  assert.equal(pick(client, toClient, ['archived', 'rome']), 'rome');
});

const CITY_CASES = [
  { name: 'an override beats the date', tx: { date: '2026-10-13', trip_stop_id: 'milan' }, want: 'milan' },
  { name: 'no override: the date decides', tx: { date: '2026-10-13', trip_stop_id: null }, want: 'rome' },
  { name: 'a pre-trip date is No city', tx: { date: '2026-03-02', trip_stop_id: null }, want: null },
  { name: 'an unknown override falls back to the date', tx: { date: '2026-10-13', trip_stop_id: 'gone' }, want: 'rome' },
];

for (const c of CITY_CASES) {
  test(`parity cityOf: ${c.name}`, () => {
    const pick = (lib, shape) => lib.cityOf(c.tx, ['rome', 'milan'].map((k) => shape(ROWS[k])))?.id ?? null;
    assert.equal(pick(server, toServer), c.want);
    assert.equal(pick(client, toClient), c.want);
  });
}

// Quick Add's decisions, client side only: the riskiest rules in the feature, and the
// client has no test runner of its own.
const { tagFor, tripSubmitFields, seedCurrency, mayRevertCurrency, tripLabel } = client;

const stopRome = { id: 'sr', name: 'Rome', startDate: '2026-10-12', endDate: '2026-10-15', currency: 'EUR', createdAt: '2026-10-01T00:00:00Z' };
const stopNaples = { id: 'sn', name: 'Naples', startDate: '2026-10-16', endDate: '2026-10-19', currency: null, createdAt: '2026-10-01T00:00:00Z' };
const italyTrip = { id: 'it', name: 'Italy', startDate: '2026-10-12', endDate: '2026-10-19', archivedAt: null, createdAt: '2026-10-01T00:00:00Z', stops: [stopRome, stopNaples] };
const parisTrip = { id: 'pa', name: 'Paris', startDate: '2026-12-01', endDate: '2026-12-05', archivedAt: null, createdAt: '2026-10-01T00:00:00Z', stops: [] };
const trips = [italyTrip, parisTrip];

test('tagFor: the date picks the trip and the stop; no override is claimed', () => {
  const tag = tagFor({ trips, date: '2026-10-13', type: 'expense' });
  assert.equal(tag.trip.id, 'it');
  assert.equal(tag.stop.id, 'sr');
  assert.equal(tag.stopIsOverride, false);
});

test('tagFor: outside every trip there is no tag', () => {
  assert.equal(tagFor({ trips, date: '2026-11-01', type: 'expense' }), null);
});

test('tagFor: no tag while trips have not loaded or failed', () => {
  assert.equal(tagFor({ trips: undefined, date: '2026-10-13', type: 'expense' }), null);
  assert.equal(tagFor({ trips: [], date: '2026-10-13', type: 'expense' }), null);
});

test('tagFor: income never carries a trip, even with a preset or a choice', () => {
  assert.equal(tagFor({ trips, date: '2026-10-13', type: 'income' }), null);
  assert.equal(tagFor({ trips, date: '2026-10-13', type: 'income', presetTripId: 'it' }), null);
  assert.equal(tagFor({ trips, date: '2026-10-13', type: 'income', choice: { tripId: 'it' } }), null);
});

test('tagFor: ✕ wins over the date and over a preset', () => {
  assert.equal(tagFor({ trips, date: '2026-10-13', type: 'expense', choice: { none: true } }), null);
  assert.equal(tagFor({ trips, date: '2026-03-02', type: 'expense', presetTripId: 'it', choice: { none: true } }), null);
});

test('tagFor: a preset holds whatever the date, with No city outside the stops', () => {
  const tag = tagFor({ trips, date: '2026-03-02', type: 'expense', presetTripId: 'it' });
  assert.equal(tag.trip.id, 'it');
  assert.equal(tag.stop, null);
  assert.equal(tag.stopIsOverride, false);
});

test('tagFor: a chosen trip outside its dates (the details picker) holds too', () => {
  const tag = tagFor({ trips, date: '2026-03-02', type: 'expense', choice: { tripId: 'pa' } });
  assert.equal(tag.trip.id, 'pa');
});

test('tagFor: choosing another stop is an override; choosing the derived one is not', () => {
  const other = tagFor({ trips, date: '2026-10-13', type: 'expense', choice: { tripId: 'it', stopId: 'sn' } });
  assert.equal(other.stop.id, 'sn');
  assert.equal(other.stopIsOverride, true);
  const same = tagFor({ trips, date: '2026-10-13', type: 'expense', choice: { tripId: 'it', stopId: 'sr' } });
  assert.equal(same.stop.id, 'sr');
  assert.equal(same.stopIsOverride, false);
});

test('tripSubmitFields: no tag sends nothing; a tag sends the trip and never a star or a group', () => {
  assert.deepEqual(tripSubmitFields(null), {});
  const tag = tagFor({ trips, date: '2026-10-13', type: 'expense' });
  assert.deepEqual(tripSubmitFields(tag), { tripId: 'it' });
});

test('tripSubmitFields: only a real override sends a stop', () => {
  const other = tagFor({ trips, date: '2026-10-13', type: 'expense', choice: { tripId: 'it', stopId: 'sn' } });
  assert.deepEqual(tripSubmitFields(other), { tripId: 'it', tripStopId: 'sn' });
  const same = tagFor({ trips, date: '2026-10-13', type: 'expense', choice: { tripId: 'it', stopId: 'sr' } });
  assert.deepEqual(tripSubmitFields(same), { tripId: 'it' });
});

const quiet = { amountTyped: false, armed: false, currencyTouched: false, declined: false };

test('seedCurrency: a stop with a currency selects it', () => {
  assert.equal(seedCurrency({ ...quiet, stop: stopRome, base: 'GBP' }), 'EUR');
});

test('seedCurrency: a stop with no currency, or no stop, wants home', () => {
  assert.equal(seedCurrency({ ...quiet, stop: stopNaples, base: 'GBP' }), 'GBP');
  assert.equal(seedCurrency({ ...quiet, stop: null, base: 'GBP' }), 'GBP');
});

test('seedCurrency: CRITICAL never changes the currency under a typed amount', () => {
  assert.equal(seedCurrency({ ...quiet, amountTyped: true, stop: stopRome, base: 'GBP' }), null);
  assert.equal(seedCurrency({ ...quiet, amountTyped: true, stop: null, base: 'GBP' }), null);
});

test('seedCurrency: CRITICAL never changes the currency under an armed chip', () => {
  assert.equal(seedCurrency({ ...quiet, armed: true, stop: stopRome, base: 'GBP' }), null);
});

test('seedCurrency: never changes a currency Alex picked', () => {
  assert.equal(seedCurrency({ ...quiet, currencyTouched: true, stop: stopRome, base: 'GBP' }), null);
  assert.equal(seedCurrency({ ...quiet, currencyTouched: true, stop: null, base: 'GBP' }), null);
});

test('seedCurrency: once declined after a failed fetch it does not re-seed (no loop)', () => {
  assert.equal(seedCurrency({ ...quiet, declined: true, stop: stopRome, base: 'GBP' }), null);
  assert.equal(seedCurrency({ ...quiet, declined: true, stop: null, base: 'GBP' }), 'GBP');
});

test('mayRevertCurrency: only with nothing typed and no chip armed', () => {
  assert.equal(mayRevertCurrency({ amountTyped: false, armed: false }), true);
  assert.equal(mayRevertCurrency({ amountTyped: true, armed: false }), false);
  assert.equal(mayRevertCurrency({ amountTyped: false, armed: true }), false);
});

test('tripLabel: with and without a city', () => {
  assert.equal(tripLabel('Italy', 'Rome'), '✈️ Italy · Rome');
  assert.equal(tripLabel('Italy', null), '✈️ Italy');
});
