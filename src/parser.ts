import { assert, Block, Choice, Code, Field, FieldID, Head, Numeric, stringUnescape, SyntaxError, Text, Token, tokenize, TokenType, Value, Nil, Anything, Record, Workspace, Reference, Do, trap, Call, arrayLast, Try, Statement, With, Base, Entry, _Array } from "./exports";

/**
 * Recursive descent parser.
 *
 * Methods starting with 'parse': A succesful parse returns a defined value and
 * advances the cursor. A failed parse returns undefined, leaves the cursor
 * unchanged, and sets an error. An unrecoverable error throws a SyntaxError
 * exception.
 *
 * Methods starting with 'require' return a value and advance the cursor, or
 * else throw an error.
 *
 * Methods starting with 'match' will return a boolean and advance the cursor on
 * succcess, leaving the cursor unchanged on failure. They do not set an error.
 *
 * Methods starting with 'peek' return a boolean but do not advance the cursor
 * or set an error.
 */
export class Parser {
  /** @throws SyntaxError */
  constructor(readonly source: string) {
    this.tokens = tokenize(this.source);
    // append end token for convenience
    this.tokens.push(new Token('end', source.length, source.length, source));
  }

  private readonly tokens: Token[];

  /** advancing cursor in tokens */
  private cursor = 0;

  /** token at cursor */
  get cursorToken(): Token {
    return this.tokens[this.cursor]
  }
  /** token before cursor */
  get prevToken(): Token {
    return this.tokens[this.cursor - 1]
  }

  /** Farthest error so far */
  error?: SyntaxError;

  /**
   * Set error if farther than previous error
   * @param message
   * @param token location of error, defaults to cursor token
   * @returns SyntaxError
   */
  setError(message: string, token?: Token): SyntaxError {
    // set error to token start, else cursor token start, else end of source
    if (!token) {
      token = this.cursorToken;
    }
    let start = token ? token.start : this.source.length;
    if (this.error && this.error.cursor > start) {
      // preserve existing farther error
    } else {
      this.error = new SyntaxError(start, this.source, message);
    }
    return this.error;
  }

  space!: Workspace;

  /** require top-level Head definition */
  requireHead(head: Head) {
    // store Space in Parser
    this.space = head.workspace;

    this.requireBlockBody(head);
    if (!this.peekToken('end')) {
      throw this.setError('Expecting top-level item definition');
    }
  }

  /** Require block with curly brackets */
  requireBlock<B extends Block>(block: B): B {
    this.requireToken('{');
    this.requireBlockBody(block);
    this.requireToken('}');
    return block;
  }

  /**
   * Require body of block inside curly brackets. Terminated by } or end.
   * @param block new block to populate.
   */
  requireBlockBody(block: Block): void {
    // assume single-line block
    block.outlined = false;
    while (true) {
      // consume separators
      while (true) {
        if (this.matchToken(',')) continue;
        if (this.matchToken(';')) continue;
        if (this.matchToken('\n')) {
          block.outlined = true;
          continue;
        }
        break;
      }

      if (this.peekToken('}', 'end')) {
        if (!block.fields.length) {
          throw this.setError('empty block', this.cursorToken)
        }
        return;
      }
      this.requireField(block);
      continue;
    }
  }


  /** Define a field in a block */
  requireField(block: Block): Field {
    const field = block instanceof Code ? new Statement : new Field;
    block.add(field);

    // dataflow qualifiers
    if (block instanceof Code) {
      assert(field instanceof Statement);
      if (this.parseToken('let')) {
        field.dataflow = 'let';
      } else if (this.parseToken('check')) {
        field.dataflow = 'check';
        if (!(block instanceof Code)) {
          throw this.setError(
            'check only allowed in program blocks',
            this.prevToken);
        }
      } else if (this.parseToken('export')) {
        field.dataflow = 'export';
        if (!(block instanceof Code)) {
          throw this.setError(
            'export only from program blocks',
            this.prevToken);
        } else if (block instanceof Try) {
          throw this.setError(
            'export from Try must be inside clause',
            this.prevToken);
        }
        if (this.parseToken('(')) {
          // type reference
          let ref = this.parseReference();
          if (!ref) throw this.setError('reference required');
          this.requireToken(')');
          if (arrayLast(ref.tokens).text !== '~') {
            throw this.setError('export reference must end with ~', this.prevToken);
            // add ~ to reference
            // Yuck: inject ~ into modified source before )
            // Maybe create special fake ~ token type?
            // let tok = this.prevToken;
            // let fake = new Token(
            //   'name',
            //   tok.start,
            //   tok.start + 1,
            //   (
            //     tok.source.slice(0, tok.start)
            //     + '~'
            //     + tok.source.slice(tok.start)
            //   )
            // );
            // ref.tokens.push(fake);
          }
          field.setMeta('^exportType', ref);
        }
      }
    }
    // name definition
    const cursor = this.cursor;
    if (this.parseToken('name') && this.parseToken(':', '=')) {
      // named field
      field.isInput = (this.prevToken.type === ':');
      // define field ID
      this.fieldID(field, this.tokens[this.cursor - 2]);
      if (block instanceof Choice) {
        if (!field.isInput) {
          throw this.setError('Option must be an input (:)', this.prevToken);
        }
        field.conditional = true;
      }
    } else {
      // anonymous output formula
      this.cursor = cursor
      field.isInput = false;
      if (block instanceof Choice) {
        throw this.setError('Option must be an input (:)', this.prevToken);
      }

      // define anonymous fieldID
      this.fieldID(field);
    }

    // parse formula
    this.requireFormula(field);

    return field;
  }

  /** define ID of field. Anonymous if nameToken undefined */
  fieldID(field: Field, nameToken?: Token) {
    if (!nameToken) {
      field.id = this.space.newFieldID(
        undefined,
        // fake = token pointing to start of formula
        Token.fake('=', this.cursorToken)
      );
      return;
    }

    // named field
    let block = field.container;
    let name = nameToken.text;
    if (name.startsWith('^')) {
      throw this.setError('Cannot define metadata', nameToken);
    }
    if (name.startsWith('~')) {
      throw this.setError('Cannot define export', nameToken);
    }
    if (name.endsWith('!') || name === '?') {
      throw this.setError('Invalid name', nameToken);
    }
    if (name.endsWith('?')) {
      // conditional field - strip ? suffix from name
      name = name.slice(0, -1);
      if (block instanceof Code && !(block instanceof Try)) {
        throw this.setError("Names in programs can't end with ?", nameToken);
      }
    } else if (block instanceof Choice) {
      throw this.setError('Option names must end in ?', nameToken);
    } else if (block instanceof Try) {
      throw this.setError('Clause names must end in ?', nameToken);
    }

    // check name is unique
    if (block.items.find(item => item !== field && item.name === name)) {
      throw this.setError('Duplicate name', nameToken);
    }

    // FieldID allocated here becomes unique identifier for field
    field.id = this.space.newFieldID(name, nameToken);
  }

  /** peek formula terminator */
  peekTerminator() {
    return this.peekToken(',', ';', ')', '}', '\n', 'end');
  }

  /** Require a formula defining a field. Sets formulaType and metadata */
  requireFormula(field: Field): void {
    let startToken = this.cursorToken;
    // parse first term of formula
    if (!this.parseTerm(field, true)) {
      throw this.setError('expecting a formula')
    }
    // parse multiterm formula into a code block
    let block: Code | undefined;
    while (!this.peekTerminator()) {
      if (!block) {
        // move first term into multi-term code block
        block = new Code;
        let first = new Statement;
        first.id = this.space.newFieldID(undefined, startToken);
        if (field.metadata) {
          first.metadata = field.metadata;
          field.metadata = undefined;
          first.metadata.containingItem = first;
        }
        let value = field.value;
        if (value) {
          field.detachValue();
          first.setValue(value);
        }
        block.add(first);
        first.formulaType = field.formulaType;
        field.formulaType = 'code';
        field.setMeta('^code', block);
      }

      let term = new Statement;
      term.id = this.space.newFieldID(undefined, this.cursorToken);
      block.add(term);
      if (!this.parseTerm(term, false)) {
        throw this.setError('expecting a formula')
      }
    }
  }

  /** parse a single term of a formula */
  parseTerm(field: Field, first = false): boolean {

    // literal value
    let literal = this.parseLiteral();
    if (literal) {
      if (field.isInput && literal instanceof Base) {
        // literal input is stored as formula to allow reset
        field.formulaType = 'literal';
        field.setMeta('^literal', literal);
      } else {
        // non-base inputs and literal outputs stored directly in value of field
        field.formulaType = 'none';
        field.value = literal;
        literal.containingItem = field;
      }
      return true;
    }

    // code block
    let code = this.parseCode();
    if (code) {
      field.formulaType = 'code';
      field.setMeta('^code', code);
      return true;
    }

    // reference
    let ref = this.parseReference();
    if (!ref && this.peekToken('|=')) {
      // implicit 'that' to left of |=
      ref = new Reference;
      ref.tokens = [Token.fake('that', this.cursorToken)];
    }
    if (ref) {
      if (
        this.matchToken(':=')
        // treat |= after structural path as separate operation
        || (ref.dependent && this.matchToken('|='))
      ) {
        // change/choose operation
        if (!ref.dependent) {
          throw this.setError(`|= requires dot-path`, ref.tokens[0]);
        }

        field.setMeta('^lhs', ref);
        field.formulaType = this.prevToken.type === ':=' ? 'change' : 'choose';

        if (field.formulaType === 'choose') {
          // option name
          let option = new Text;
          option.token = this.requireToken('name');
          option.value = option.token.text;
          if (option.value.endsWith('?')) {
            throw this.setError(`option name shouldn't have ?`, option.token)
          }
          field.setMeta('^option', option);
          // formula is optional
          if (this.peekTerminator()) return true;
        }

        // parse formula into ^rhs
        let rhs = field.setMeta('^rhs', undefined);
        this.requireFormula(rhs);
        return true;
      }

      let call = this.parseCall(ref, first);
      if (call) {
        // call
        field.formulaType = 'call';
        field.setMeta('^call', call);
        return true;
      }

      // plain reference
      field.formulaType = 'reference';
      field.setMeta('^reference', ref);
      return true;
    }

    // include
    if (this.matchToken('include')) {
      field.formulaType = 'include';
      // ignore name for now - only include builtins
      this.requireToken('name');
      return true;
    }

    // builtin
    if (this.matchToken('builtin')) {
      let name = new Text;
      name.value = this.requireToken('name').text;
      field.formulaType = 'builtin';
      field.setMeta('^builtin', name);
      return true;
    }

    return false;

  }

  /** parse arguments following a reference. Param first rejects
   * syntax 'ref value x' and 'ref value('*/
  parseCall(ref: Reference, first = false): Call | undefined {

    // unparenthesized value following function reference
    let startCursor = this.cursor;
    let startToken = this.cursorToken;
    let rightValue = this.parseLiteral() || this.parseReference();
    if (
      rightValue
      && first
      && (
        this.parseReference()
        || this.parseLiteral()
        || this.parseToken('(')
      )
    ) {
      // reject ternary form at beginning of formula
      this.cursor = startCursor;
      return undefined;
    }
    if (!rightValue && !this.matchToken('(')) {
      return undefined;
    }
    if (ref.dependent) {
      // function references must be structureal
      throw this.setError('function is dependent', ref.tokens[0]);
    }
    let call = new Call;

    call.token = arrayLast(ref.tokens);
    // first statement of call is reference to function
    ref.tokens.push(Token.fake('call', this.prevToken));
    let prog = new Statement;
    prog.id = this.space.newFieldID(undefined, this.prevToken);
    call.add(prog);
    prog.formulaType = 'reference';
    prog.setMeta('^reference', ref);

    // second statement of call is input argument change operation
    let input = new Statement;
    input.id = this.space.newFieldID(undefined, this.prevToken);
    call.add(input);
    input.formulaType = 'changeInput';
    // LHS is dependent ref to first input
    let lhs = new Reference;
    lhs.tokens = [
      Token.fake('that', this.prevToken),
      Token.fake('arg1', this.prevToken)
    ]
    input.setMeta('^lhs', lhs);
    // RHS is structural reference to input value
    let rhsRef = new Reference;
    rhsRef.tokens = [Token.fake('input', this.prevToken)]
    let rhs = input.setMeta('^rhs');
    rhs.formulaType = 'reference';
    rhs.setMeta('^reference', rhsRef);

    if (rightValue) {
      // unparenthesized value argument
      let arg = new Statement;
      arg.formulaType = 'change';
      let lhs = new Reference;
      lhs.tokens = [
        Token.fake('that', startToken),
        Token.fake('arg2', startToken)
      ]
      arg.setMeta('^lhs', lhs);
      let rhs = arg.setMeta('^rhs');
      if (rightValue instanceof Reference) {
        rhs.formulaType = 'reference';
        rhs.setMeta('^reference', rightValue)
      } else {
        rhs.formulaType = 'none';
        rhs.setValue(rightValue);
      }
      arg.id = this.space.newFieldID(undefined, startToken);
      call.add(arg);
      return call;
    }

    // parse arguments into change operations
    while (!this.parseToken(')')) {
      let arg = new Statement;
      let argToken = this.cursorToken;
      this.requireFormula(arg)
      if (arg.formulaType !== 'change') {
        // anonymous first argument
        if (call.fields.length !== 2) {
          throw this.setError('Only first argument can be anonymous', argToken);
        }
        // move formula to RHS of arg2 change operation
        let anon = arg;
        arg = new Statement;
        arg.formulaType = 'change';
        let lhs = new Reference;
        lhs.tokens = [
          Token.fake('that', argToken),
          Token.fake('arg2', argToken)
        ]
        arg.setMeta('^lhs', lhs);
        let rhsValue = anon.value;
        if (rhsValue) anon.detachValue();
        let rhs = arg.setMeta('^rhs', rhsValue);
        rhs.formulaType = anon.formulaType;
        if (anon.metadata) {
          rhs.metadata = anon.metadata;
          rhs.metadata.containingItem = rhs;
        }
      }

      arg.id = this.space.newFieldID(undefined, argToken);
      call.add(arg);
      this.matchToken(',');
    }

    return call;
  }

  /** parse a code block */
  parseCode(): Code | undefined {
    let token = this.parseToken('do', 'with', 'try');
    if (!token) return undefined;
    switch (token.type) {
      case 'do':
        return this.requireBlock(new Do);

      case 'with':
        return this.requireBlock(new With);

      case 'try':
        return this.requireTry()

      default:
        trap();
    }
  }

  /** Require try block */
  requireTry(): Try {
    let block = new Try;
    // assume single-line block
    block.outlined = false;
    while (true) {
      let endCursor = this.cursor

      // consume separators
      while (true) {
        if (this.matchToken('\n')) {
          block.outlined = true;
          continue;
        }
        // inline separators allowed after first clause
        if (block.fields.length && this.matchToken(',')) continue;
        if (block.fields.length && this.matchToken(';')) continue;
        break;
      }

      // optional clause name
      let nameToken = this.parseToken('name');
      if (nameToken && !this.parseToken('=')) {
        // not a named clause
        this.cursor = endCursor;
        break;
      }
      if (!block.fields.length) {
        // first clause
      } else if (this.matchToken('else')) {
        if (this.matchToken('reject')) {
          // final reject clause marks try as conditional
          block.conditional = true;
          break;
        }
      } else {
        // terminate if not another else clause
        this.cursor = endCursor;
        break;
      }

      // parse clause
      let statement = new Statement;
      block.add(statement);
      this.fieldID(statement, nameToken);
      let clause = new Code;
      statement.formulaType = 'code';
      statement.setMeta('^code', clause);
      this.requireBlock(clause);

      // whole try is outline if any clause is
      if (clause.outlined) block.outlined = true;

      continue;
    }
    return block;
  }

  /** Returns a Reference with tokens[] containing name tokens which may include
   * a leading ^/~ and trailing ?/!. Will contain leading 'that' for dependent
   * path. Also contains number tokens for testing. [] template access is
   * converted to a name token. [formula] indexing will return a
   * ReferenceFormula instead.
   * */
  parseReference(): Reference | undefined {
    let tokens: Token[] = [];

    // leading name or that
    if (this.matchToken('name', 'that')) {
      if (this.prevToken.text[0] === '^') {
        throw this.setError("Reference can't start with ^", this.cursorToken);
      }
      if (this.prevToken.type === 'name' && this.prevToken.text[0] === '~') {
        // leading ~-name simulates leading 'that'
        tokens.push(Token.fake('that', this.prevToken));
      }
      tokens.push(this.prevToken);
    } else if (this.peekToken('.')) {
      // leading . simulates leading 'that'
      tokens.push(Token.fake('that', this.cursorToken));
    }

    // rest of path
    while (true) {
      if (this.matchToken('.')) {
        this.requireToken('name', 'number');
        if (this.prevToken.text[0] === '^') {
          throw this.setError("^ can't follow .", this.prevToken)
        }
        tokens.push(this.prevToken);
        continue;
      } else if (this.peekToken('name') && this.cursorToken.text[0] === '^') {
        // metadata
        tokens.push(this.cursorToken);
        this.cursor++;
        continue;
      } else if (this.peekToken('name') && this.cursorToken.text[0] === '~') {
        // import with optionally suffixed field name
        let importToken = this.cursorToken;
        this.cursor++;
        // split token into ~ and suffix
        tokens.push(new Token(
          'name',
          importToken.start,
          importToken.start + 1,
          importToken.source));
        if (importToken.text.length > 1) {
          // add fake token for suffixed name of export
          tokens.push(new Token(
            'name',
            importToken.start + 1,
            importToken.end,
            importToken.source
          ));
          if (importToken.text === '~?' || importToken.text === '~!') {
            throw this.setError("? or ! goes before ~ not after")
          }
        }
        continue;
      } else if (this.matchToken('[')) {
        // indexing
        if (this.matchToken(']')) {
          // template access - convert epty brackets to a name
          tokens.push(new Token(
            'name',
            this.tokens[this.cursor - 2].start,
            this.prevToken.end,
            this.prevToken.source
          ));
          continue;
        }
        // TODO: formula indexing
        trap();
      }
      break;
    }

    if (!tokens.length) return undefined;
    let ref = new Reference;
    ref.tokens = tokens;
    return ref;
  }

  /** Parse a literal value */
  parseLiteral(): Value | undefined {
    if (this.matchToken('number')) {
      let num = new Numeric;
      num.token = this.prevToken;
      num.value = Number(this.prevToken.text);
      assert(Number.isFinite(num.value));
      return num;
    }

    if (this.matchToken('_number_')) {
      let num = new Numeric;
      num.token = this.prevToken;
      num.value = NaN;
      return num;
    }

    if (this.matchToken('string')) {
      let text = new Text;
      text.token = this.prevToken;
      text.value = stringUnescape(this.prevToken.text.slice(1, -1));
      return text;
    }

    if (this.matchToken('nil')) {
      let nil = new Nil;
      nil.token = this.prevToken;
      return nil;
    }

    if (this.matchToken('anything')) {
      let any = new Anything;
      any.token = this.prevToken;
      return any;
    }

    if (this.matchToken('record')) {
      return this.requireBlock(new Record);
    }

    if (this.matchToken('choice')) {
      return this.requireBlock(new Choice);
    }

    if (this.matchToken('array')) {
      this.requireToken('{');
      let templateValue = this.parseLiteral();
      if (!templateValue) throw this.setError('expecting a template value')
      this.requireToken('}');
      let array = new _Array;
      let template = new Entry;
      array.template = template;
      template.id = 0;
      template.container = array;
      template.setValue(templateValue);
      template.isInput = false;
      template.formulaType = 'none';
      return array;
    }

    this.setError('Expecting a value');
    return undefined;
  }


  /** require one of several token types */
  requireToken(...types: TokenType[]): Token {
    let token = this.parseToken(...types);
    if (!token) {
      throw this.error;
    }
    return token;
  }


  /** parse one of several token types */
  parseToken(...types: TokenType[]): Token | undefined {
    if (this.matchToken(...types)) {
      return this.prevToken;
    }
    this.setError('Expecting ' + types.join(' or '));
    return undefined;
  }

  /** match one of several token types */
  matchToken(...types: TokenType[]) {
    if (this.peekToken(...types)) {
      this.cursor++;
      return true;
    }
    return false;
  }

  /** peek one of several token types */
  peekToken(...types: TokenType[]): boolean {
    let cursorType = this.cursorToken.type;
    for (let type of types) {
      if (type === cursorType) return true;
    }
    return false;
  }
}