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
    assert(!item.up);
    item.up = this;
    this.items.push(item);
  }

  /** execute all items */
  exec() {
    this.items.forEach(item => item.exec());
  }
  
  /** make copy, bottom up, translating paths contextually */
  copy(src: Path, dst: Path): this {
    let to = super.copy(src, dst);
    this.items.forEach(item => {
      to.add(item.copy(src, dst));
    })
    return to;
  }


}