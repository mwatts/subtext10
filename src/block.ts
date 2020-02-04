import { assert, Container, ID, Item, isNumber, Token, Path, Dictionary, Value } from "./exports";

/** A Block is a record-like container with a fixed set of items called fields.
 * Each field can have a different type. Each Field has a globally unique
 * FieldID which optionally gives it a name. */

export class Block<F extends Field = Field> extends Container<F> {

  /** whether block is displayed as an outline or a single line */
  outlined = true;

  get fields() {
    return this.items;
  }

  /** add a Field */
  add(field: F) {
    this.fields.push(field);
    assert(!field.up);
    field.up = this;
  }

  /** the item with an ID else undefined */
  get(id: ID): F | undefined {
    if (id instanceof FieldID) {
      return this.fields.find(field => field.id === id);
    }
    if (isNumber(id)) {
      // use number as ordinal index
      return this.fields[id - 1];
    }
    let ordinal = Number(id)
    if (Number.isFinite(ordinal)) {
      // convert string to ordinal
      return this.fields[ordinal - 1];
    }
    // search by name
    return this.fields.find(field => field.name === id);
  }
 
  copy(src: Path, dst: Path): this {
    let to = super.copy(src, dst);
    to.outlined = this.outlined;
    return to;
  }

  // dump as an object
  dump() {
    let obj: Dictionary<any> = {};
    this.fields.forEach((field, i) => {
      obj[field.name ?? i + 1] = field.dump();
    })
    return obj;
  }
}

/** Field is an Item with a FieldID and a Value */
export class Field<I extends FieldID = FieldID, V extends Value = Value> extends Item<I, V> {

  /** dataflow qualifier: check/let/extra */
  dataflow?: 'let' | 'check' | 'extra';

  get name() { return this.id.name }

  copy(src: Path, dst: Path): this {
    let to = super.copy(src, dst);
    to.dataflow = this.dataflow;
    return to;
  }
}

/** doc-unique ID of a Field. Immutable and interned */
export class FieldID {

  /** doc serial # of field */
  readonly serial: number;

  /** name of field, without trailing ?. undefined if unnamed */
  name?: string;

  /** source token where defined, for parsing errors */
  token?: Token;

  constructor(serial: number) {
    this.serial = serial;
  }

  toString() {
    return this.name ?? this.serial.toString();
  }
}

/** data block */
export class Record extends Block {

}