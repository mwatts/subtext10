import { assert, Item, Value, another, Path } from "./exports";

/** superclass of Block and Series, the two kinds of containers. */
export abstract class Container<I extends Item> extends Value {

  /** array of items in proper order */
  items: I[] = [];

  /** top-down iteration through all items */
  *visit(): IterableIterator<Item> {
    for (let item of this.items) {
      yield* item.visit();
    }
  }


  /** add an item to end */
  add(item: I) {
    assert(!item.container);
    item.container = this;
    this.items.push(item);
  }

  /** evaluate all items */
  eval() {
    this.items.forEach(item => item.eval());
  }

  /** make copy, bottom up, translating paths contextually */
  copy(srcPath: Path, Path: Path): this {
    let to = super.copy(srcPath, Path);
    this.items.forEach(item => {
      assert(item.container === this);
      to.add(item.copy(srcPath, Path));
    })
    return to;
  }


}