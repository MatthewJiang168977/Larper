import { readFileSync } from 'fs';
import { join } from 'path';
import { HoursTextError, parseHoursText } from './parse';

const here = join(__dirname, 'testdata/parse-vectors.json');
const vectors = JSON.parse(readFileSync(here, 'utf8')) as {
  accepted: { input: string; schedule: unknown }[];
  rejected: string[];
};

describe('parseHoursText', () => {
  it('has the same vectors as the Go tests', () => {
    const go = join(__dirname, '../../../../workers/internal/hours/testdata/parse-vectors.json');
    expect(readFileSync(go, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(here, 'utf8').replace(/\r\n/g, '\n'));
  });
  it.each(vectors.accepted)('reads $input', ({ input, schedule }) => {
    expect(parseHoursText(input)).toEqual(schedule);
  });
  it.each(vectors.rejected)('refuses %j', (input) => {
    expect(() => parseHoursText(input)).toThrow(HoursTextError);
  });
});
