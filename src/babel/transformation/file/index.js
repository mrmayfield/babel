import convertSourceMap from "convert-source-map";
import moduleFormatters from "../modules";
import OptionManager from "./options/option-manager";
import PluginManager from "./plugin-manager";
import shebangRegex from "shebang-regex";
import NodePath from "../../traversal/path";
import isFunction from "lodash/lang/isFunction";
import sourceMap from "source-map";
import generate from "../../generation";
import codeFrame from "../../helpers/code-frame";
import defaults from "lodash/object/defaults";
import includes from "lodash/collection/includes";
import traverse from "../../traversal";
import Logger from "./logger";
import Plugin from "../plugin";
import parse from "../../helpers/parse";
import Hub from "../../traversal/hub";
import * as util from  "../../util";
import path from "path";
import * as t from "../../types";

export default class File {
  constructor(opts = {}, pipeline) {
    this.transformerDependencies = {};

    this.dynamicImportTypes = {};
    this.dynamicImportIds   = {};
    this.dynamicImports     = [];

    this.declarations = {};
    this.usedHelpers  = {};
    this.dynamicData  = {};
    this.data         = {};

    this.metadata = {
      modules: {
        imports: [],
        exports: {
          exported: [],
          specifiers: []
        }
      }
    };

    this.pipeline = pipeline;
    this.log      = new Logger(this, opts.filename || "unknown");
    this.opts     = this.initOptions(opts);
    this.ast      = {};

    this.buildTransformers();

    this.hub = new Hub(this);
  }

  static helpers = [
    "inherits",
    "defaults",
    "create-class",
    "create-decorated-class",
    "create-decorated-object",
    "define-decorated-property-descriptor",
    "tagged-template-literal",
    "tagged-template-literal-loose",
    "to-array",
    "to-consumable-array",
    "sliced-to-array",
    "sliced-to-array-loose",
    "object-without-properties",
    "has-own",
    "slice",
    "bind",
    "define-property",
    "async-to-generator",
    "interop-require-wildcard",
    "interop-require-default",
    "typeof",
    "extends",
    "get",
    "set",
    "class-call-check",
    "object-destructuring-empty",
    "temporal-undefined",
    "temporal-assert-defined",
    "self-global",
    "default-props",
    "instanceof",

    // legacy
    "interop-require"
  ];

  static soloHelpers = [];

  initOptions(opts) {
    opts = new OptionManager(this.log, this.pipeline).init(opts);

    if (opts.inputSourceMap) {
      opts.sourceMaps = true;
    }

    if (opts.moduleId) {
      opts.moduleIds = true;
    }

    opts.basename = path.basename(opts.filename, path.extname(opts.filename));

    opts.ignore = util.arrayify(opts.ignore, util.regexify);

    if (opts.only) opts.only = util.arrayify(opts.only, util.regexify);

    defaults(opts, {
      moduleRoot: opts.sourceRoot
    });

    defaults(opts, {
      sourceRoot: opts.moduleRoot
    });

    defaults(opts, {
      filenameRelative: opts.filename
    });

    defaults(opts, {
      sourceFileName: opts.filenameRelative,
      sourceMapTarget:  opts.filenameRelative
    });

    //

    if (opts.externalHelpers) {
      this.set("helpersNamespace", t.identifier("babelHelpers"));
    }

    return opts;
  }

  isLoose(key: string) {
    return includes(this.opts.loose, key);
  }

  buildTransformers() {
    var file = this;

    var transformers = this.transformers = {};

    var secondaryStack = [];
    var stack = [];

    // build internal transformers
    for (var key in this.pipeline.transformers) {
      var transformer = this.pipeline.transformers[key];
      let pass = transformers[key] = transformer.buildPass(file);

      if (pass.canTransform()) {
        stack.push(pass);

        if (transformer.metadata.secondPass) {
          secondaryStack.push(pass);
        }

        if (transformer.manipulateOptions) {
          transformer.manipulateOptions(file.opts, file);
        }
      }
    }

    // init plugins!
    var beforePlugins = [];
    var afterPlugins = [];
    var pluginManager = new PluginManager({
      file: this,
      transformers: this.transformers,
      before: beforePlugins,
      after: afterPlugins
    });
    for (var i = 0; i < file.opts.plugins.length; i++) {
      pluginManager.add(file.opts.plugins[i]);
    }
    stack = beforePlugins.concat(stack, afterPlugins);

    // build transformer stack
    this.uncollapsedTransformerStack = stack = stack.concat(secondaryStack);

    // build dependency graph
    for (let pass of (stack: Array)) {
      for (var dep of (pass.plugin.dependencies: Array)) {
        this.transformerDependencies[dep] = pass.key;
      }
    }

    // collapse stack categories
    this.transformerStack = this.collapseStack(stack);
  }

  collapseStack(_stack) {
    var stack  = [];
    var ignore = [];

    for (let pass of (_stack: Array)) {
      // been merged
      if (ignore.indexOf(pass) >= 0) continue;

      var group = pass.plugin.metadata.group;

      // can't merge
      if (!pass.canTransform() || !group) {
        stack.push(pass);
        continue;
      }

      var mergeStack = [];
      for (let pass of (_stack: Array)) {
        if (pass.plugin.metadata.group === group) {
          mergeStack.push(pass);
          ignore.push(pass);
        }
      }

      var visitors = [];
      for (let pass of (mergeStack: Array)) {
        visitors.push(pass.plugin.visitor);
      }
      var visitor = traverse.visitors.merge(visitors);
      var mergePlugin = new Plugin(group, { visitor });
      stack.push(mergePlugin.buildPass(this));
    }

    return stack;
  }

  set(key: string, val): any {
    return this.data[key] = val;
  };

  setDynamic(key: string, fn: Function) {
    this.dynamicData[key] = fn;
  }

  get(key: string): any {
    var data = this.data[key];
    if (data) {
      return data;
    } else {
      var dynamic = this.dynamicData[key];
      if (dynamic) {
        return this.set(key, dynamic());
      }
    }
  }

  resolveModuleSource(source: string): string {
    var resolveModuleSource = this.opts.resolveModuleSource;
    if (resolveModuleSource) source = resolveModuleSource(source, this.opts.filename);
    return source;
  }

  addImport(source: string, name?: string, type?: string): Object {
    name = name || source;
    var id = this.dynamicImportIds[name];

    if (!id) {
      source = this.resolveModuleSource(source);
      id = this.dynamicImportIds[name] = this.scope.generateUidIdentifier(name);

      var specifiers = [t.importDefaultSpecifier(id)];
      var declar = t.importDeclaration(specifiers, t.literal(source));
      declar._blockHoist = 3;

      if (type) {
        var modules = this.dynamicImportTypes[type] = this.dynamicImportTypes[type] || [];
        modules.push(declar);
      }

      if (this.transformers["es6.modules"].canTransform()) {
        this.moduleFormatter.importSpecifier(specifiers[0], declar, this.dynamicImports, this.scope);
        this.moduleFormatter.hasLocalImports = true;
      } else {
        this.dynamicImports.push(declar);
      }
    }

    return id;
  }

  attachAuxiliaryComment(node: Object): Object {
    var beforeComment = this.opts.auxiliaryCommentBefore;
    if (beforeComment) {
      node.leadingComments = node.leadingComments || [];
      node.leadingComments.push({
        type: "CommentLine",
        value: " " + beforeComment
      });
    }

    var afterComment = this.opts.auxiliaryCommentAfter;
    if (afterComment) {
      node.trailingComments = node.trailingComments || [];
      node.trailingComments.push({
        type: "CommentLine",
        value: " " + afterComment
      });
    }

    return node;
  }

  addHelper(name: string): Object {
    var isSolo = includes(File.soloHelpers, name);

    if (!isSolo && !includes(File.helpers, name)) {
      throw new ReferenceError(`Unknown helper ${name}`);
    }

    var declar = this.declarations[name];
    if (declar) return declar;

    this.usedHelpers[name] = true;

    if (!isSolo) {
      var generator = this.get("helperGenerator");
      var runtime   = this.get("helpersNamespace");
      if (generator) {
        return generator(name);
      } else if (runtime) {
        var id = t.identifier(t.toIdentifier(name));
        return t.memberExpression(runtime, id);
      }
    }

    var ref = util.template("helper-" + name);

    var uid = this.declarations[name] = this.scope.generateUidIdentifier(name);

    if (t.isFunctionExpression(ref) && !ref.id) {
      ref.body._compact = true;
      ref._generated = true;
      ref.id = uid;
      ref.type = "FunctionDeclaration";
      this.attachAuxiliaryComment(ref);
      this.path.unshiftContainer("body", ref);
    } else {
      ref._compact = true;
      this.scope.push({
        id: uid,
        init: ref,
        unique: true
      });
    }

    return uid;
  }

  errorWithNode(node, msg, Error = SyntaxError) {
    var err;
    if (node && node.loc) {
      var loc = node.loc.start;
      err = new Error(`Line ${loc.line}: ${msg}`);
      err.loc = loc;
    } else {
      // todo: find errors with nodes inside to at least point to something
      err = new Error("There's been an error on a dynamic node. This is almost certainly an internal error. Please report it.");
    }
    return err;
  }

  mergeSourceMap(map: Object) {
    var opts = this.opts;

    var inputMap = opts.inputSourceMap;

    if (inputMap) {
      map.sources[0] = inputMap.file;

      var inputMapConsumer   = new sourceMap.SourceMapConsumer(inputMap);
      var outputMapConsumer  = new sourceMap.SourceMapConsumer(map);
      var outputMapGenerator = sourceMap.SourceMapGenerator.fromSourceMap(outputMapConsumer);
      outputMapGenerator.applySourceMap(inputMapConsumer);

      var mergedMap = outputMapGenerator.toJSON();
      mergedMap.sources = inputMap.sources;
      mergedMap.file    = inputMap.file;
      return mergedMap;
    }

    return map;
  }


  getModuleFormatter(type: string) {
    if (isFunction(type) || !moduleFormatters[type]) {
      this.log.deprecate("Custom module formatters are deprecated and will be removed in the next major. Please use Babel plugins instead.");
    }

    var ModuleFormatter = isFunction(type) ? type : moduleFormatters[type];

    if (!ModuleFormatter) {
      var loc = util.resolveRelative(type);
      if (loc) ModuleFormatter = require(loc);
    }

    if (!ModuleFormatter) {
      throw new ReferenceError(`Unknown module formatter type ${JSON.stringify(type)}`);
    }

    return new ModuleFormatter(this);
  }

  parse(code: string) {
    var opts = this.opts;

    //

    var parseOpts = {
      highlightCode: opts.highlightCode,
      nonStandard:   opts.nonStandard,
      filename:      opts.filename,
      plugins:       {}
    };

    var features = parseOpts.features = {};
    for (var key in this.transformers) {
      var transformer = this.transformers[key];
      features[key] = transformer.canTransform();
    }

    parseOpts.looseModules = this.isLoose("es6.modules");
    parseOpts.strictMode = features.strict;
    parseOpts.sourceType = "module";

    this.log.debug("Parse start");
    var tree = parse(code, parseOpts);
    this.log.debug("Parse stop");
    return tree;
  }

  _addAst(ast) {
    this.path = NodePath.get({
      hub: this.hub,
      parentPath: null,
      parent: ast,
      container: ast,
      key: "program"
    }).setContext();
    this.scope = this.path.scope;
    this.ast   = ast;
  }

  addAst(ast) {
    this.log.debug("Start set AST");
    this._addAst(ast);
    this.log.debug("End set AST");

    this.log.debug("Start module formatter init");
    var modFormatter = this.moduleFormatter = this.getModuleFormatter(this.opts.modules);
    if (modFormatter.init && this.transformers["es6.modules"].canTransform()) {
      modFormatter.init();
    }
    this.log.debug("End module formatter init");
  }

  transform() {
    this.call("pre");
    for (var pass of (this.transformerStack: Array)) {
      pass.transform();
    }
    this.call("post");

    return this.generate();
  }

  wrap(code, callback) {
    code = code + "";

    try {
      if (this.shouldIgnore()) {
        return this.makeResult({ code, ignored: true });
      } else {
        return callback();
      }
    } catch (err) {
      if (err._babel) {
        throw err;
      } else {
        err._babel = true;
      }

      var message = err.message = `${this.opts.filename}: ${err.message}`;

      var loc = err.loc;
      if (loc) {
        err.codeFrame = codeFrame(code, loc.line, loc.column + 1, this.opts);
        message += "\n" + err.codeFrame;
      }

      if (err.stack) {
        var newStack = err.stack.replace(err.message, message);
        try {
          err.stack = newStack;
        } catch (e) {
          // `err.stack` may be a readonly property in some environments
        }
      }

      throw err;
    }
  }

  addCode(code: string) {
    code = (code || "") + "";
    code = this.parseInputSourceMap(code);
    this.code = code;
  }

  parseCode() {
    this.parseShebang();
    this.addAst(this.parse(this.code));
  }

  shouldIgnore() {
    var opts = this.opts;
    return util.shouldIgnore(opts.filename, opts.ignore, opts.only);
  }

  call(key: string) {
    for (var pass of (this.uncollapsedTransformerStack: Array)) {
      var fn = pass.plugin[key];
      if (fn) fn(this);
    }
  }

  parseInputSourceMap(code: string) {
    var opts = this.opts;

    if (opts.inputSourceMap !== false) {
      var inputMap = convertSourceMap.fromSource(code);
      if (inputMap) {
        opts.inputSourceMap = inputMap.toObject();
        code = convertSourceMap.removeComments(code);
      }
    }

    return code;
  }

  parseShebang() {
    var shebangMatch = shebangRegex.exec(this.code);
    if (shebangMatch) {
      this.shebang = shebangMatch[0];
      this.code = this.code.replace(shebangRegex, "");
    }
  }

  makeResult({ code, map = null, ast, ignored }) {
    var result = {
      metadata: null,
      ignored:  !!ignored,
      code:     null,
      ast:      null,
      map:      map
    };

    if (this.opts.code) {
      result.code = code;
    }

    if (this.opts.ast) {
      result.ast = ast;
    }

    if (this.opts.metadata) {
      result.metadata = this.metadata;
      result.metadata.usedHelpers = Object.keys(this.usedHelpers);
    }

    return result;
  }

  generate() {
    var opts = this.opts;
    var ast  = this.ast;

    var result = { ast };
    if (!opts.code) return this.makeResult(result);

    this.log.debug("Generation start");

    var _result = generate(ast, opts, this.code);
    result.code = _result.code;
    result.map  = _result.map;

    this.log.debug("Generation end");

    if (this.shebang) {
      // add back shebang
      result.code = `${this.shebang}\n${result.code}`;
    }

    if (result.map) {
      result.map = this.mergeSourceMap(result.map);
    }

    if (opts.sourceMaps === "inline" || opts.sourceMaps === "both") {
      result.code += "\n" + convertSourceMap.fromObject(result.map).toComment();
    }

    if (opts.sourceMaps === "inline") {
      result.map = null;
    }

    return this.makeResult(result);
  }
}
