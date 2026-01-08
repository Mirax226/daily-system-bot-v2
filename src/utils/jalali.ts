type JalaliDate = { year: number; month: number; day: number };
type GregorianDate = { year: number; month: number; day: number };

const breaks = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178
];

const div = (a: number, b: number): number => Math.floor(a / b);

const g2d = (gy: number, gm: number, gd: number): number => {
  const d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * ((gm + 9) % 12) + 2, 5) +
    gd -
    34840408;
  return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
};

const d2g = (jdn: number): GregorianDate => {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div((j % 1461), 4) * 5 + 308;
  const gd = div((i % 153), 5) + 1;
  const gm = div(i, 153) % 12 + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { year: gy, month: gm, day: gd };
};

const jalCal = (jy: number): { leap: number; gy: number; march: number } => {
  let bl = breaks.length;
  let gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  let jump = 0;

  if (jy < jp || jy >= breaks[bl - 1]) {
    throw new Error('Invalid Jalali year');
  }

  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(jump % 33, 4);
    jp = jm;
  }

  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div((n % 33) + 3, 4);
  if (jump % 33 === 4 && jump - n === 4) {
    leapJ += 1;
  }

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) {
    n = n - jump + div(jump + 4, 33) * 33;
  }
  const leap = ((n + 1) % 33 - 1) % 4;

  return { leap, gy, march };
};

const j2d = (jy: number, jm: number, jd: number): number => {
  const r = jalCal(jy);
  return (
    g2d(r.gy, 3, r.march) +
    (jm - 1) * 31 -
    div(jm, 7) * (jm - 7) +
    jd -
    1
  );
};

const d2j = (jdn: number): JalaliDate => {
  const g = d2g(jdn);
  const gy = g.year;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  let jm;
  let jd;

  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = (k % 31) + 1;
      return { year: jy, month: jm, day: jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }

  jm = 7 + div(k, 30);
  jd = (k % 30) + 1;
  return { year: jy, month: jm, day: jd };
};

export const isValidJalaliDate = (year: number, month: number, day: number): boolean => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  if (month <= 6) return day <= 31;
  if (month <= 11) return day <= 30;
  const { leap } = jalCal(year);
  return day <= (leap === 0 ? 29 : 30);
};

export const jalaliToGregorian = (year: number, month: number, day: number): GregorianDate => {
  if (!isValidJalaliDate(year, month, day)) {
    throw new Error('Invalid Jalali date');
  }
  return d2g(j2d(year, month, day));
};

export const gregorianToJalali = (year: number, month: number, day: number): JalaliDate => {
  return d2j(g2d(year, month, day));
};

export type { JalaliDate, GregorianDate };
