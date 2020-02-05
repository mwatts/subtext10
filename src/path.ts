import { MetaID, VersionID, assert, FieldID, Base, another, Token, Item, trap, Field, Block, Value, arrayEquals, assertDefined, PendingValue } from "./exports";

/**
 * ID of an item. Immutable and interned, so can use ===
 * Series use plain JS numbers, either ordinals or serial numbers.
 * Strings are used as a convenience in APIs but not used as Item id
 */
export type RealID = FieldID | number;
export type ID = RealID | string;

/** Absolute path within the doc. A sequence of IDs starting with the
 * VersionID in the Head. Immutable after construction */
export class Path {

  readonly ids: ReadonlyArray<ID>;
  get length() { return this.ids.length }

  constructor(ids: ReadonlyArray<ID>) {
    this.ids = ids;
  }

  static readonly empty = new Path([]);

  /** Whether path is absolute path witin doc. Otherwise it is relative to
   * contextual input value */
  get isAbsolute() {
    return this.ids[0] instanceof VersionID;
  };


  /** extend path downward */
  down(id: ID): Path {
    return new Path([...this.ids, id]);
  }

  /** path equality */
  equals(other: Path) {
    return (
      this.ids.length === other.ids.length
      && this.ids.every((id, i) => id === other.ids[i]));
  }

  /** Whether other path is within but not equal to this path */
  contains(other: Path): boolean {
    return (
      // must be longer
      other.length > this.length
      // not in our metadata
      && !(other.ids[this.length] instanceof MetaID)
      // must extend this path
      && this.ids.every((id, i) => id === other.ids[i]));
  }

  containsOrEquals(other: Path): boolean {
    return this.equals(other) || this.contains(other);
  }


  /**
  * Path translation. Paths within a deep copy get translated, so that any path
  * contained in the source of the copy gets translated into a path contained in
  * the destination. Relative paths are not translated.
  */
  translate(src: Path, dst: Path): Path {
    // don't translate relative paths
    if (!this.isAbsolute) return this;
    if (src.contains(this)) {
      // translate from src to dst
      return new Path([...dst.ids, ...this.ids.slice(src.length)]);
    }
    // disallow destination from "capturing" path outside src into dst
    // this should be caught during static analysis as a cyclic reference
    assert(!dst.contains(this));
    return this;
  }

  toString() { return this.dump() };

  // dump path as dotted string
  dump() { return this.ids.join('.'); }
}

/** Guard on an ID in a reference */
type Guard = '?' | '!' | undefined;

/** Path as a value of an item. Only used in metadata */
export class Reference extends Base {

  /** Tokens of path in source. May have leading '.' token. Name tokens have
   * leading ^/~ and trailing ?/!. Number tokens used for testing */
  tokens?: Token[];

  /** Path of IDs */
  path!: Path;

  /** guards for each ID in path. IDs above LUB of absolute path must be unguarded  */
  guards!: Guard[];


  /** Dereference */
  deref(from: Item): Value {
    if (!this.path) {
      // bind path
      this.bind(from);
    }
    // dereference
    trap();


  }

  // bind reference during analysis
  private bind(from: Item) {
    assert(this.doc.analyzing);
    assert(this.tokens);
    switch (this.tokens[0]?.text[0]) {
      case '.':
      case '^':
      case '~':
        // relative reference
        trap();
        return;
      default:
        break;
    }

    // bind absolute reference

    // strip out guards from names
    let tokenNames: string[] = [];
    let tokenGuards: Guard[] = [];
    this.tokens.forEach(token => {
      let suffix = token.text.slice(-1);
      switch (suffix) {
        case '?':
        case '!':
          tokenGuards.push(suffix);
          tokenNames.push(token.text.slice(0, -1));
          return;
        default:
          tokenGuards.push(undefined);
          tokenNames.push(token.text);
          return;
      }
    });

    // bind first name lexically
    let first = tokenNames[0];

    // lexically bind by searching upward to match first name
    // Note upwards scan skips from metadata to base item's container
    let target: Item | undefined;
    for (let up of from.upwards()) {
      if (up.value instanceof Block) {
        // bind against field names in Block container
        target = up.value.fields.find(field => field.name === first);
        if (target) break;
      }
      continue;
    }
    if (!target) {
      // hit top without binding - try builtins
      // generalize to includes?
      trap();
      // let builtins = cast(base.root.getMeta('^builtins'), Data);
      // scope = builtins.fields.find(field => field.name.label === first);
      // // TODO - search downward into builtins to allow sub-modules
      // if (!scope) {
      //   throw new AnalysisError(tokens[0], 'Name not defined in context');
      // }
    }
    if (target === from) {
      // self reference
      trap();
    }

    // path starts at lexical binding, unguarded above
    let ids: ID[] = target.path.ids.slice();
    let guards: Guard[] = ids.slice(1).map(() => undefined);
    guards.push(tokenGuards[0]);
    // follow path downwards through blocks, advancing target
    for (let i = 1; i < this.tokens.length; i++) {
      let token = this.tokens[i];
      let name = tokenNames[i];
      let guard = tokenGuards[i];

      if (name.startsWith('~')) {
        // TODO - extra results
        // split into two steps to access field of extra results
        trap();
      }

      if (!target.value) {
        // target value undefined. Evaluate it
        target.eval();
        assert(target.value);
      } else if (target.value instanceof PendingValue) {
        // cyclic dependency
        trap()
      }

      target = target.value.getMaybe(name);
      if (!target) {
        // undefined ID
        trap();
      }
      if (target === from) {
        // self reference
        trap();
      }
      // append to path
      ids.push(target.id);
      guards.push(guard);
      if (!!guard !== target.isConditional) {
        // guard and conditionality don't match
        trap();
      }
    }

    // establish Path
    this.path = new Path(ids);
    this.guards = guards;

    /** Disallow recursive paths from within the base case of a Choice or Try */
    if (this.path.containsOrEquals(from.path)) {
      trap();
    }

  }


  /** make copy, bottom up, translating paths contextually */
  copy(src: Path, dst: Path): this {
    let to = another(this);
    to.path = this.path.translate(src, dst);
    // translate guards
    if (this.path.isAbsolute && src.contains(this.path)) {
      // Adjust unguarded accesses to context
      assert(
        this.guards.slice(0, src.length)
          .every(guard => guard === undefined)
      );

      to.guards = [
        ...dst.ids.map(_ => undefined),
        ...this.guards.slice(src.length)
      ];

    } else {
      to.guards = this.guards;
    }
    return to;
  }

  equals(other: any) {
    return (
      other instanceof Reference
      && this.path.equals(other.path)
      && arrayEquals(this.guards, other.guards)
    );
  }

  dump() { return this.path.dump(); }
}
