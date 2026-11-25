import { z } from 'zod';

export function decimal(maximum: number, minimum = 0) {
  return z
    .union([z.string(), z.number()])
    .transform(String)
    .refine(
      (value) => /^\d{1,4}(\.\d{1,2})?$/.test(value) && Number(value) >= minimum && Number(value) <= maximum,
      'Provide a value within range with at most two decimal places.',
    )
    .transform((value) => Number(value).toFixed(2));
}

export function hundredths(value: string | number) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function gcd(left: bigint, right: bigint) {
  while (right) [left, right] = [right, left % right];
  return left;
}

export class Ratio {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator = 0n, denominator = 1n) {
    if (denominator <= 0n || numerator < 0n)
      throw new RangeError('Expected a nonnegative ratio with positive denominator');
    const divisor = gcd(numerator, denominator);
    this.numerator = numerator / divisor;
    this.denominator = denominator / divisor;
  }

  static decimal(value: string | number) {
    return new Ratio(hundredths(value), 100n);
  }

  add(other: Ratio): Ratio {
    return new Ratio(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  scale(numerator: bigint, denominator = 1n): Ratio {
    return new Ratio(this.numerator * numerator, this.denominator * denominator);
  }

  below(other: Ratio): boolean {
    return this.numerator * other.denominator < other.numerator * this.denominator;
  }

  format(): string {
    const rounded = (200n * this.numerator + this.denominator) / (2n * this.denominator);
    return (rounded / 100n).toString() + '.' + (rounded % 100n).toString().padStart(2, '0');
  }
}

export function scoreRatio(points: string, maximum: string): Ratio {
  return new Ratio(hundredths(points), hundredths(maximum));
}
