import { Workspace, ID, Path, Container, Value, RealID, Metadata, MetaID, isString, another, Field, Reference, trap, assert, Code, Token, cast, arrayLast, Call, Text, evalBuiltin, Try, assertDefined, builtinWorkspace, Statement, Choice, arrayReplace, Metafield, _Number, Nil, Loop, OptionReference, Update} from "./exports";
/**
 * An Item contains a Value. A Value may be a Container of other items. Values
 * that do not contain Items are Base values. This forms a tree, where Values
 * are the nodes and Items are the edges. The top Item is a Workspace. Each
 * contained item carries an ID, and we identify items by the path of IDs down
 * from the top.
 */

export abstract class Item<I extends RealID = RealID, V extends Value = Value> {

  /** Physical container */
  container!: Container<this>;

  /** memoized Workspace */
  _workspace?: Workspace;
  get workspace(): Workspace {
    if (!this._workspace) {
      this._workspace = this.container.workspace;
    }
    return this._workspace;
  }

  /** ID of the item within its container */
  id!: I;

  /** memoized Path */
  _path?: Path;
  get path(): Path {
    if (!this._path) {
      this._path = this.container.containingItem.path.down(this.id);
    }
    return this._path
  }
  // FIXME: report ordinals on anon fields, not serials
  get pathString() { return this.path.toString(); }

  /** whether this item is in an array template */
  get inTemplate() { return this.path.ids.includes(0) }

  /** Logical container: metadata is physically contained in base item, but
   * logically is a peer */
  get up(): Item {
    return this.container!.up;
  }

  /** iterate upwards through logical containers to Workspace */
  *upwards(): Generator<Item> {
    for (
      let item: Item = this.up;
      !(item instanceof Workspace);
      item = item.up
    ) {
      yield item;
    }
  }

  /** iterate upwards starting with this */
  *thisUpwards(): Generator<Item> {
    yield this;
    yield* this.upwards();
  }

  /** top-down iteration through all items */
  *visit(): IterableIterator<Item> {
    if (this.metadata) {
      yield* this.metadata.visit();
    }
    yield this;
    if (this.value instanceof Container) {
      yield* this.value.visit()
    }
  }

  /** Metadata block. Undefined if no metadata */
  metadata?: Metadata;

  /** the Item at a downward path else trap. Accepts a dotted string or ID[] */
  down(path: Path | ID[] | string): Item {
    if (path === '') return this;
    let ids = (
      path instanceof Path
        ? path.ids
        : typeof path === 'string'
          ? path.split('.')
          : path
    )
    let target: Item = this;
    ids.forEach(id => {
      target = target.get(id);
    });
    return target;
  }

  /** the contained item with an ID else trap */
  get(id: ID): Item {
    return this.getMaybe(id) ?? trap(this.path + ': ' + id + ' undefined');
  }

  /** the contained item with an ID else undefined */
  getMaybe(id: ID): Item | undefined {
    if (
      id instanceof MetaID
      || (isString(id) && id.startsWith('^'))
    ) {
      // metadata access
      let metafield = this.metadata?.getMaybe(id);
      if (metafield) return metafield;
      if (id === '^initial' || id === MetaID.ids['^initial']) {
        // synthesize ^initial metadata to access initial value of an input
        // copy base item into ^initial
        // currently only used on options. Could just compile it into their
        // definitions
        assert(this.isInput);
        this.resolve();
        let copy = this.copy(this.path, this.path.down(MetaID.ids['^initial']));
        let initial = this.setMeta('^initial');
        // transfer copy into metafield
        initial.formulaType = copy.formulaType;
        initial.isInput = false;
        if (copy.metadata) {
          initial.metadata = copy.metadata;
          initial.metadata.containingItem = initial;
        }
        if (copy.formulaType === 'none') {
          let value = assertDefined(copy.value);
          copy.detachValue();
          initial.setValue(value);
        }
        return initial;
      }
      return undefined;
    }

    // evaluate and get from value
    return this.value?.getMaybe(id);
  }

  /** set a metadata field by name. Must not already exist. Value can be
   * undefined */
  setMeta(name: string, value?: Value): Metafield {
    if (!this.metadata) {
      // allocate metadata block
      this.metadata = new Metadata;
      this.metadata.containingItem = this;
    }
    return this.metadata.set(name, value);
  }

  /** create or replace metadata with copy of value of item. Can also supply a
   * value or string or number */
  replaceMeta(name: string, value: Item | Value | string | number): Metafield {
    let meta = this.getMaybe(name) as Metafield;
    if (meta) {
      meta.detachValue();
    } else {
      meta = this.setMeta(name);
    }
    meta.setFrom(value);
    return meta;
  }

  /**
   * How value is computed. The formula is stored in various metadata fields
   * depending on this tag.
   *
   * FIXME: this sould be encoded as metadata using standard datatypes.
   * formulaType should become a Choice. Optionality should be made explicit.
   *
   * none: value is a constant in item.value. Used for literal outputs.
   *
   * literal: value is in ^literal
   *
   * reference: value is target of a Reference in ^reference
   *
   * code: value is result of a Code block in ^code
   *
   * loop: value is result of a Loop block in ^loop
   *
   * replace: dependent reference in ^target, formula in ^payload
   *
   * replaceInput: special replace used for input of a call
   *
   * write: formula in ^delta, structural reference in ^target
   *
   * choose: dependent optionReference in ^target, optional formula in ^payload
   *
   * call: Call block in ^call, starting with reference to function followed by
   * replaces on the arguments
   *
   * include: currently includes only builtins
   *
   * builtin: ^builtin contains name of builtin as a Text value
   *
   *  */
  formulaType: (
    'none' | 'literal' | 'reference' | 'code' | 'replace' | 'replaceInput'
    | 'write' | 'choose' | 'call' | 'include' | 'builtin' | 'loop'
  ) = 'none';

  /** whether input or output item */
  isInput = false;

  /** updatable output */
  isUpdatableOutput = false;

  /** whether value should be rederived on copies */
  get isDerived() {
    return !this.isInput && this.formulaType !== 'none'
  }

  /** whether item can reject having a value. Determined during analysis */
  conditional = false;

  setConditional(b?: boolean) {
    if (!b) return;
    if (this.workspace.analyzing) {
      this.conditional = true;
    } else {
      assert(this.conditional);
    }
  }

  /** Evaluation rejected. Not copied */
  rejected = false;

  /** value of item. Undefined when not yet derived from formula or rejected.
   * Copied on non-derived items  */
  value?: V;

  /** false before evaluated, undefined during evaluation, true afterwards */
  evaluated: boolean | undefined = false;

  /** thunk for deferred analysis of item. Used to break recursive dependencies.
   * this.evaluated should be set undefined */
  deferral?: () => void;

  /** resolve deferral, leaving item evaluated */
  resolve() {
    let deferral = this.deferral;
    if (!deferral) return;
    if (this.isDetached()) {
      debugger;
    } else {
      assert(this.workspace.analyzing);
    }
    // set item unevaluated, with deferral to catch cycles
    this.evaluated = false;
    this.deferral = () => {
      throw new StaticError(this, 'circular dependency')
    }
    // execute thunk
    deferral();
    // item should have been evaluated
    assert(this.evaluated);
    this.deferral = undefined;
  }

  /** max depth of items */
  static readonly DepthLimit = 100;

  /** Evaluate metadata and value */
  eval() {
    // skip if pending
    if (this.evaluated === undefined) return
    if (this.value) {
      if (this.evaluated) return;
      assert(!this.isDerived);
      // set evaluation pending
      this.evaluated = undefined;
      // evaluate metadata then contents
      this.metadata?.eval();
    } else if (this.rejected) {
      assert(this.evaluated);
      return;
    } else {

      // derive value
      // set evaluation pending
      assert(!this.evaluated);
      this.evaluated = undefined;

      if (this.path.length > Item.DepthLimit) {
        throw new Crash(this.container.token!, 'Workspace too deep')
      }

      // evaluate metadata
      this.metadata?.eval();

      // evaluate formula
      switch (this.formulaType) {
        case 'literal':
          this.copyValue(this.get('^literal'));
          break;

        case 'reference':
          let ref = cast(this.get('^reference').value, Reference);
          this.setConditional(ref.conditional);
          this.rejected = ref.rejected;
          this.copyValue(ref.target);
          break;

        case 'code':
          this.result(cast(this.get('^code').value, Code));
          break;

        case 'loop':
          let loop = cast(this.get('^loop').value, Loop);
          loop.execute(cast(this, Statement));
          break;

        case 'call':
          this.result(cast(this.get('^call').value, Call));
          break;

        case 'replace':
        case 'replaceInput':
        case 'choose':
          this.replace();
          break;

        case 'write':
          // write is actually performed in triggering replace operation
          // target and delta in metadata already evaluated
          // copy value of delta
          this.copyValue(this.get('^delta'));
          break;

        case 'include':
          this.copyValue(builtinWorkspace.currentVersion);
          break;

        case 'builtin':
          let name = cast(this.get('^builtin').value, Text).value;
          evalBuiltin(cast(this, Statement), name);
          break;

        default:
          trap();
      }
    }

    // evaluate value contents deeply
    // Don't do this on the function bodies in a Call
    // or update sections post analysis
    // FIXME: this looks like a huge mistake
    // Should have separated shallow and deep evaluation
    // maybe causes some of the needs for deferred evaluation
    // evalIfNeeded was another workaround
    if (this.value
      && !(this.container instanceof Call)
      && !(this.value instanceof Update && !this.workspace.analyzing)) {
      this.value.eval();
    }

    this.evaluated = true;
  }

  /** get result of code or call */
  private result(code: Code) {
    this.setConditional(code.conditional);
    this.rejected = code.rejected;
    this.copyValue(code.result);

    if (code.export) {
      let exportField = this.replaceMeta('^export', code.export);
      exportField.setConditional(code.conditional);
      exportField.rejected = code.rejected;
    } else {
      let exportField = this.getMaybe('^export');
      if (exportField) {
        // runtime rejection of export
        assert(code.rejected);
        exportField.rejected = true;
        exportField.detachValue();
      }
    }
  }

  /** evaluate replace/choose operation, setting value of this item */
  private replace() {
    // target and payload in metadata already evaluated
    const ref = cast(this.get('^target').value, Reference);
    assert(ref.dependent);
    // get previous value, which is context of reference
    this.setConditional(ref.conditional);
    if (ref.rejected) {
      // target reference rejected
      this.rejected = true;
      if (!this.workspace.analyzing) return;
    }
    assert(ref.target);
    const context = this.workspace.down(ref.path.ids.slice(0, ref.context));
    // context.eval(); // don't think this is needed
    // copy previous value of context into result value
    this.copyValue(context);

    // follow target dependent path within result value
    let target = this.down(ref.path.ids.slice(ref.context));

    // choose
    if (this.formulaType === 'choose') {
      assert(ref instanceof OptionReference);
      let choice = target.value;
      assert(choice instanceof Choice);
      let option = target.get(ref.optionID);
      // resolve deferred analysis of the option
      option.resolve();

      choice.setChoice(choice.fields.indexOf(option as Field));
      // set option value from payload
      target = option;
    } else {
      // replaces need to be within previous value
      assert(ref.path.length > ref.context);
    }

    let payload = this.getMaybe('^payload');
    if (!payload) {
      // payload optional in choose
      assert(this.formulaType === 'choose')
    } else {
      // replace target value with payload value
      target.eval();
      if (!target.value!.changeableFrom(payload.value!)) {
        throw new StaticError(ref.tokens[0], 'changing type of value')
      }
      this.setConditional(payload.conditional);
      if (payload.rejected) this.rejected = true;

      target.detachValue();
      assert(payload.value);
      target.copyValue(payload);
      if (this.formulaType === 'replaceInput') {
        // initialize call body to recalc input defaults
        // preserving primary input value
        // let input = assertDefined(target.value);
        // target.container.initialize();
        // if (!target.value) {
        //   target.setValue(input);
        // }
        assert(target === target.container.items[0]);
        target.container.items.slice(1).forEach(statement =>
          statement.initialize())
      }
    }

    // check that target location is updatable in context
    let source = ref.target;
    for (
      target = this.down(ref.path.ids.slice(ref.context));
      target !== this;
      target = target.container.containingItem
    ) {
      if (target.isInput) {
        source = source.container.containingItem
        continue;
      }
      if (target.isUpdatableOutput) break;
      throw new StaticError(
        ref.tokens[ref.context + target.path.length - this.path.length],
        'not updatable output')
    }
    if (target === this) {
      // target is inputs up to context - done
      return;
    }
    assert(this.formulaType !== 'replaceInput');

    /** Output update. Output updates are handled by explicit update blocks and
     * implicit reverse execution of code blocks. These are executed in strict
     * backwards tree order. Updates propagate backwards in the context value
     * until they all ground out in input fields.
     *
     * Updates are executed within the input context value, stored in ^change
     * metdata, and tracked in the array pendingDeltas. Updates grounding out in
     * input fields get written into the copy of the context in value of this
     * field.
     *
     * TODO: drop equal changes
     * TODO: aggregate changes inside an updatable output
     * TODO: detect overwrites
     * TODO: Defer updates that try to escape context
    */

    // move target in result value to ^change in input. The rest of the replace
    // operation will work inside the input value until it is done

    // stack of pending changes, sorted in tree order
    const pendingChanges = [source.replaceMeta('^change', target)];
    target.detachValue();
    // array of grounded changes (on input fields)
    const groundedChanges: Metafield[] = [];

    // propagate changes in reverse tree order
    while (pendingChanges.length) {
      let change = pendingChanges.pop()!;
      let output = change.base;

      // TODO: reverse function execution

      // ground out changes to inputs
      if (!output.isUpdatableOutput) {
        assert(output.isInput);
        groundedChanges.push(change);
        continue;
      }

      switch (output.formulaType) {

        case 'code': {
          // execute update block at end of code block
          // note types were already checked during analysis of def site
          let code = cast(output.get('^code').value, Code);
          let update = cast(arrayLast(code.statements).value, Update);

          // set input change of update block
          update.initialize();
          let input = update.statements[0];
          assert(input.isInput && !input.value);
          input.setFrom(change);
          // evaluate update and queue up writes
          update.eval();
          // FIXME scan nested code blocks for writes
          for (let write of update.statements) {
            if (write.formulaType !== 'write') continue;
            const targetRef = cast(write.get('^target').value, Reference);
            let target = targetRef.target!;
            if (!context.path.contains(target.path)) {
              // TODO: defer entire replace if leaves context
              trap();
            }
            if (!context.isWritable(target)) {
              throw new StaticError(arrayLast(targetRef.tokens),
                'unwritable location')
            }
            let targetChange =
              target.replaceMeta('^change', assertDefined(write.value));
            // insert into pending changes sorted by location
            let i = pendingChanges.length;
            while (i > 0 && target.comesBefore(pendingChanges[--i].base)) { }
            pendingChanges.splice(i + 1, 0, targetChange);
          }
          break;
        }

        case 'reference':

        default:
          trap();
      }
      continue;
    }

    // replace grounded changes in result, which was copied earlier from context
    for (let grounded of groundedChanges) {
      // follow path within change context
      let target = this.down(grounded.base.path.ids.slice(ref.context));
      target.detachValue()
      target.copyValue(grounded);
    }
  }

  /** whether a contained item is writable in this context. Must be inputs up to
   * a containing updatable output or this */
  isWritable(item: Item): boolean {
    // scan upwards to this
    for (; item !== this; item = item.container.containingItem) {
      if (item instanceof Metafield) return false;
      if (item.isUpdatableOutput) return true;
      if (!item.isInput) return false;
    }
    return true;
  }

  /** Iterate through containing items, starting with this and ending with
   * Workspace */
  *containmentWalk(): Generator<Item> {
    for (
      let item: Item = this;
      item.container;
      item = item.container.containingItem
    ) {
      yield item;
    }
  }

  /** whether this item comes before other item in tree (but doesn't contain
   * other item) */
  comesBefore(other: Item): boolean {
    // construct containment arrays starting with workspace
    let thisItems = Array.from(this.containmentWalk()).reverse();
    let otherItems = Array.from(other.containmentWalk()).reverse();
    for (let i = 0; i < Math.min(thisItems.length, otherItems.length); i++) {
      // find where containment paths diverge
      let thisItem = thisItems[i];
      let otherItem = otherItems[i];
      if (thisItem === otherItem) continue;
      assert(i > 0); // workspaces must be the same

      let siblings = thisItem.container.items;
      if (siblings !== otherItem.container.items) {
        // comparing metadata and base data
        // metadata comes before base data
        return thisItem instanceof Metafield;
      }
      // compare container indexes
      return siblings.indexOf(thisItem) < siblings.indexOf(otherItem)
    }
    // one item contains other
    // If this item is metadata of other it comes before
    return thisItems[otherItems.length] instanceof Metafield;
  }

  /** whether this item uses the value of the previous item */
  usesPrevious = false;

  /** The previous item in evaluation order. Used by dependent references. */
  previous(): Item | undefined {
    // should only be used during analysis to bind references
    assert(this.workspace.analyzing);
    this.usesPrevious = true;
    let container = this.container;
    let itemIndex = container.items.indexOf(this);
    assert(itemIndex >= 0);
    if (
      !itemIndex
      || container instanceof Metadata
      || container instanceof Try
    ) {
      // At beginning of container, or in metadata/try
      // Use previous in grand-container. Scan stops in Version
      return container.containingItem.previous();
    }
    // previous item in container, skipping certain statements
    while (itemIndex) {
      let prev = container.items[--itemIndex]
      if (prev instanceof Statement && prev.dataflow) continue;
      // also skip includes
      if (prev.formulaType === 'include') continue;
      return prev;
    }
    // skip to container
    return container.containingItem.previous();
  }

  /** initialize all values */
  initialize() {
    this.resolve();
    if (this.metadata) this.metadata.initialize();
    this.evaluated = false;
    assert(this.formulaType);
    if (this.formulaType !== 'none') {
      // recalc value
      this.rejected = false;
      if (this.value) this.detachValue();
      return;
    }
    // recurse on predefined values
    assert(!this.rejected);
    this.value!.initialize();
  }

  /** detach value, so a new one can be set */
  detachValue() {
    assert(this.value?.containingItem === this);
    this.value.containingItem = undefined as any;
    this.value = undefined;
    this.evaluated = false;
  }

  /** whether item has been detached */
  isDetached(): boolean {
    for (let up: Item = this; up; up = up.container.containingItem) {
      if (up instanceof Workspace) {
        return false;
      }
    }
    return true;
  }

  /** set detached value */
  setValue(value: Value) {
    assert(!this.value);
    assert(!value.containingItem);
    this.value = value as V;
    value.containingItem = this;
  }

  /** Copy current value from another item, translating internal path. Does
   * nothing if item or its value are undefined */
  copyValue(src?: Item) {
    if (src && src.value) {
      this.setValue(src.value.copy(src.path, this.path));
    }
  }

  /** set value, allowing a JS number or string. Copies Value if attached.
   * Asserts argument defined */
  setFrom(from?: number | string | Value | Item) {
    assert(from !== undefined);
    if (typeof from === 'number') {
      let value = new _Number;
      value.value = from
      this.setValue(value);
    } else if (typeof from === 'string') {
      let value = new Text;
      value.value = from;
      this.setValue(value);
    } else {
      let value = from instanceof Item ? assertDefined(from.value) : from;
      if (value.containingItem) {
        // copy attached value
        this.setValue(value.copy(value.containingItem.path, this.path));
      } else {
        // set detached Value
        this.setValue(value);
      }
    }
  }

  // /** replace current value from another item, translating internal path. Just
  //  * prunes current value if item or its value are undefined */
  // replaceValue(src?: Item) {
  //   this.prune();
  //   if (src && src.value) {
  //     this.setValue(src.value.copy(src.path, this.path));
  //   }
  // }

  /** source of value through copying */
  // FIXME prob should be a Path, translated through copies
  source?: this;

  /** original source of this item via copying. That is, its definition */
  get origin(): this {
    return this.source ? this.source.origin : this;
  }

  /** make copy, bottom up, translating paths contextually */
  copy(srcPath: Path, dstPath: Path): this {
    if (this.path.length > Item.DepthLimit) {
      throw new Crash(this.container.token!, 'Workspace too deep')
    }

    let to = another(this);
    to.id = this.id;
    to.formulaType = this.formulaType;
    to.isInput = this.isInput;
    to.isUpdatableOutput = this.isUpdatableOutput;
    to.conditional = this.conditional;
    to.usesPrevious = this.usesPrevious;

    // record copy
    to.source = this;

    if (this.deferral) {
      // defer copying a deferred item
      to.evaluated = undefined;
      to.deferral = () => {
        // resolve this item
        assert(this.container && to.container)
        this.resolve();
        let newCopy = this.copy(srcPath, dstPath);
        // tranfer new copy to original deferred copy already in workspace
        assert(to.id === newCopy.id);
        to.formulaType = newCopy.formulaType;
        to.isInput = newCopy.isInput;
        to.conditional = newCopy.conditional;
        to.usesPrevious = newCopy.usesPrevious
        if (newCopy.metadata) {
          to.metadata = newCopy.metadata;
          to.metadata.containingItem = to;
        }
        let newValue = newCopy.value!;
        newCopy.detachValue();
        to.setValue(newValue);
        // evaluate
        to.eval();
      }
      return to;
    }

    // copy metadata
    if (this.metadata) {
      to.metadata = this.metadata.copy(srcPath, dstPath);
      to.metadata.containingItem = to;
    }

    // copy underived values
    if (this.value && !this.isDerived) {
      assert(this.value.containingItem === this);
      to.value = this.value.copy(srcPath, dstPath);
      to.value.containingItem = to;
    }

    return to;
  }

  /** Type-checking for replace operations. Can this item be changed from
   * another. Recurses within a path context, which defaults to item paths */
  changeableFrom(from: Item, fromPath?: Path, thisPath?: Path): boolean {
    this.resolve();
    from.resolve();
    if (!thisPath) thisPath = this.path;
    if (!fromPath) fromPath = from.path;
    return (
      this.id === from.id
      && this.isInput === from.isInput
      && this.conditional === from.conditional
      && this.formulaType === from.formulaType
      && (
        this.formulaType !== 'none'
        || this.value!.changeableFrom(from.value!, fromPath, thisPath)
      )
      && !!this.metadata === !!from.metadata
      && (
        !this.metadata
        || this.metadata.changeableFrom(from.metadata!, fromPath, thisPath)
      )
    )
  }

  /** item equality, assuming changeableFrom is true */
  equals(other: Item) {
    return (
      this.id === other.id
      && this.rejected === other.rejected
      && !!this.value === !!other.value
      && (!this.value || this.value.equals(other.value))
    )
  }

  // dump value
  dump() { return this.value ? this.value.dump() : {'': 'undefined'}}
}

/** FIXME: reify into state so unaffected items can operate */
export class StaticError extends Error {
  constructor(token: Token | Item | undefined, description: string) {
    super(description + ': ' + StaticError.context(token));
  }
  private static context(token?: Token | Item): string {
    if (token instanceof Item) {
      if (token instanceof Field) {
        token = token.id.token;
      } else {
        token = undefined;
      }
    }
    return (
      token instanceof Token
        ? token.source.slice(token.start, token.end + 10)
        : 'unknown'
    )
  }
}

/** dynamic crash error */
export class Crash extends Error {
  constructor(token?: Token, description = 'crash') {
    super(
      description + ': '
      + token?.source?.slice(token.start, token.end + 10)
    );
  }
}