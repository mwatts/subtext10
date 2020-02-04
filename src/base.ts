import { Value, another, Path, escapedString } from "./exports";

/** Base items contain no other items */
export abstract class Base extends Value {

  // base values don't execute
  exec() { return; }
}

/**
 * A JS number.
 * NaN is the missing number _number_ which is equal to itself.
 */
export class Numeric extends Base {
  value: number = NaN;

  copy(src: Path, dst: Path): this {
    let to = super.copy(src, dst);
    to.value = this.value;
    return to;
  }

  equals(other: any) {
    return (
      other instanceof Numeric
      && (
        this.value === other.value
        || (Number.isNaN(this.value) && Number.isNaN(other.value))));
  }

  // dump as number
  dump() { return this.value };
}

export class Character extends Base {
  /**
   * a single-character string.
   * could be a charCode instead
   */
  value: string = ' ';

  copy(src: Path, dst: Path): this {
    let to = super.copy(src, dst);
    to.value = this.value;
    return to;
  }

  equals(other: any) {
    return other instanceof Character && this.value === other.value;
  }

  // dump as string
  dump() { return this.value };
}

/** Nil is the unit type with one value */
export class Nil extends Base {

  equals(other: any) {
    return other instanceof Nil;
  }

  // dump as null
  dump() { return null };
}

/** Anything is the top type used in generics */
export class Anything extends Base {

  equals(other: any) {
    return other instanceof Anything;
  }

  // dump as undefined
  dump() { return undefined };
}

/** PendingValue is used to detect cyclic formulas */
export class PendingValue extends Base {

  equals(other: any) {
    return other instanceof PendingValue;
  }

  // dump as special object
  dump() { return { '': 'Pending'} };
}