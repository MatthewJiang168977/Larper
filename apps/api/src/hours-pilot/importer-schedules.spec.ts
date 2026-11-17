import { readFileSync } from 'fs';
import { join } from 'path';
import { stateAt, validateSchedule } from '../hours/schedule';

// testdata/importer-schedules.json is written by the Go importer's own test
// (workers/cmd/hours-pilot-import): the exact JSON it puts in place_hours_facts.schedule.
// The API reads that column with validateSchedule, so every one must be accepted unchanged.
const golden: Record<string, unknown> = JSON.parse(readFileSync(join(__dirname, 'testdata/importer-schedules.json'), 'utf8'));

describe('what the hours-pilot importer writes, as the API reads it', () => {
  it.each(Object.keys(golden))('%s is a valid v1 schedule', (hours) => {
    const s = validateSchedule(golden[hours]);
    expect(s).not.toBeNull();
    expect(s?.partial).toBe('none');
  });

  it('evaluates: Mo-Fr 09:00-17:00 is open Wednesday noon in New York and closed Saturday noon', () => {
    const s = validateSchedule(golden['Mo-Fr 09:00-17:00']);
    expect(stateAt(s, new Date('2026-11-18T17:00:00Z'))).toBe('open'); // Wed 12:00 EST
    expect(stateAt(s, new Date('2026-11-21T17:00:00Z'))).toBe('closed'); // Sat 12:00 EST
  });

  it('evaluates: Mo-Su 17:00-02:00 runs past midnight', () => {
    const s = validateSchedule(golden['Mo-Su 17:00-02:00']);
    expect(stateAt(s, new Date('2026-11-19T06:00:00Z'))).toBe('open'); // Thu 01:00 EST
    expect(stateAt(s, new Date('2026-11-19T12:00:00Z'))).toBe('closed'); // Thu 07:00 EST
  });
});
