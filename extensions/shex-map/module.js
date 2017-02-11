/*
 * TODO
 *   templates: @<foo> %map:{ my:specimen.container.code=.1.code, my:specimen.container.disp=.1.display %}
 *   node identifiers: @foo> %map:{ foo.id=substr(20) %}
 *   multiplicity: ...
 */
var N3 = require("n3");
var N3Util = N3.Util;

var _ = require('underscore');

var ShExUtil = require("../../lib/ShExUtil");
var extensions = require("./lib/extensions");

var MapExt = "http://shex.io/extensions/Map/#";
var pattern = /^ *(?:<([^>]*)>|([^:]*):([^ ]*)) *$/;

function register (validator) {
  var prefixes = "prefixes" in validator.schema ?
      validator.schema.prefixes :
      {};

  validator.semActHandler.results[MapExt] = {};
  validator.semActHandler.register(
    MapExt,
    {
      /**
       * Callback for extension invocation.
       *
       * @param {string} code - text of the semantic action.
       * @param {object} ctx - matched triple or results subset.
       * @param {object} extensionStorage - place where the extension writes into the result structure.
       * @return {bool} false if the extension failed or did not accept the ctx object.
       */
      dispatch: function (code, ctx, extensionStorage) {
        function fail (msg) { var e = Error(msg); Error.captureStackTrace(e, fail); throw e; }
        function getPrefixedName(bindingName) {
           // already have the fully prefixed binding name ready to go
           if (_.isString(bindingName)) return bindingName;

           // bindingName is from a pattern match - need to get & expand it with prefix
            var prefixedName = bindingName[1] ? bindingName[1] :
                bindingName[2] in prefixes ? (prefixes[bindingName[2]] + bindingName[3]) :
                fail("unknown prefix " + bindingName[2] + " in \"" + code + "\".");
            return prefixedName;
        }

        var update = function(bindingName, value) {

            if (!bindingName) {
               throw Error("Invocation error: " + MapExt + " code \"" + code + "\" didn't match " + pattern);
            }

            var prefixedName = getPrefixedName(bindingName);
            var quotedValue = value; // _.isNull(value.match(/"(.+)"/)) ? '"' + value + '"' : value;

            validator.semActHandler.results[MapExt][prefixedName] = quotedValue;
            extensionStorage[prefixedName] = quotedValue;
        };

        // Do we have a map extension function?
        if (/.*[(].*[)].*$/.test(code)) {

            var results = extensions.lift(code, ctx.object, prefixes);
            _.mapObject(results, function(val, key) {
                update(key, val);
            });
        } else {
          var bindingName = code.match(pattern);
          update(bindingName, ctx.object);
        }

        return true;
      }
    }
  );
  return validator.semActHandler.results[MapExt];
}

function done (validator) {
  if (Object.keys(validator.semActHandler.results[MapExt]).length === 0)
    delete validator.semActHandler.results[MapExt];
}

function n3ify (ldterm) {
  if (typeof ldterm !== "object")
    return ldterm;
  var ret = "\"" + ldterm.value + "\"";
  if ("language" in ldterm)
    return ret + "@" + ldterm.language;
  if ("type" in ldterm)
    return ret + "^^" + ldterm.type;
  return ret;
}

function materializer (schema, nextBNode) {
  var blankNodeCount = 0;
  nextBNode = nextBNode || function () {
    return '_:b' + blankNodeCount++;
  };
  return {
    materialize: function (bindings, createRoot, shape, target) {
      shape = shape || schema.start;
      target = target || N3.Store();
      target.addPrefixes(schema.prefixes); // not used, but seems polite

      var curSubject = createRoot || B();
      var curSubjectx = {cs: curSubject};

      var v = ShExUtil.Visitor();
      var oldVisitShapeRef = v.visitShapeRef;

      v.visitShapeRef = function (shapeRef) {
        this.visitShapeExpr(schema.shapes[shapeRef.reference], shapeRef.reference);
        return oldVisitShapeRef.call(v, shapeRef);
      };

      v.visitValueRef = function (r) {
        this.visitExpression(schema.shapes[r.reference], r.reference);
        return this._visitValue(r);
      };

      v.visitTripleConstraint = function (expr) {
        myvisitTripleConstraint(expr, curSubjectx, nextBNode, target, this, schema, bindings);
      };

      v.visitShapeExpr(shape, "_: -start-");
      return target;
    }
  };
}

function myvisitTripleConstraint (expr, curSubjectx, nextBNode, target, visitor, schema, bindings) {
      function P (pname) { return N3Util.expandPrefixedName(pname, schema.prefixes); }
      function L (value, modifier) { return N3Util.createLiteral(value, modifier); }
      function B () { return nextBNode(); }
      // utility functions for e.g. s = add(B(), P(":value"), L("70", P("xsd:float")))
      function add (s, p, o) { target.addTriple({ subject: s, predicate: p, object: n3ify(o) }); return s; }

        var mapExts = (expr.semActs || []).filter(function (ext) { return ext.name === MapExt; });
        if (mapExts.length) {
          mapExts.forEach(function (ext) {
            var code = ext.code;
            var m = code.match(pattern);

            var tripleObject;
            if (m) { 
              var arg = m[1] ? m[1] : P(m[2] + ":" + m[3]);
              var val = bindings.get(arg);
              if (!_.isUndefined(val)) {
                tripleObject = val;
              }
            }

            // Is the arg a function? Check if it has parentheses and ends with a closing one
            if (_.isUndefined(tripleObject)) {
              if (/[ a-zA-Z0-9]+\(/.test(code)) 
                  tripleObject = extensions.lower(code, bindings, schema.prefixes);
            }

            if (_.isUndefined(tripleObject)) console.warn('Not in bindings: ',code);
            add(curSubjectx.cs, expr.predicate, tripleObject);
          });

        } else if ("values" in expr.valueExpr && expr.valueExpr.values.length === 1) {
          add(curSubjectx.cs, expr.predicate, expr.valueExpr.values[0]);

        } else {
          var oldSubject = curSubjectx.cs;
          curSubjectx.cs = B();
          add(oldSubject, expr.predicate, curSubjectx.cs);
          visitor._maybeSet(expr, { type: "TripleConstraint" }, "TripleConstraint",
                         ["inverse", "negated", "predicate", "valueExpr",
                          "min", "max", "annotations", "semActs"])
          curSubjectx.cs = oldSubject;
        }
      }
function extractBindingsDelMe (soln, min, max, depth) {
  if ("min" in soln && soln.min < min)
    min = soln.min
  var myMax = "max" in soln ?
      (soln.max === "*" ?
       Infinity :
       soln.max) :
      1;
  if (myMax > max)
    max = myMax

  function walkExpressions (s) {
    return s.expressions.reduce((inner, e) => {
      return inner.concat(extractBindingsDelMe(e, min, max, depth+1));
    }, []);
  }

  function walkTriple (s) {
    var fromTriple = "extensions" in s && MapExt in s.extensions ?
        [{ depth: depth, min: min, max: max, obj: s.extensions[MapExt] }] :
        [];
    return "referenced" in s ?
      fromTriple.concat(extractBindingsDelMe(s.referenced.solution, min, max, depth+1)) :
      fromTriple;
  }

  function structuralError (msg) { throw Error(msg); }

  var walk = // function to explore each solution
      soln.type === "someOfSolutions" ||
      soln.type === "eachOfSolutions" ? walkExpressions :
      soln.type === "tripleConstraintSolutions" ? walkTriple :
      structuralError("unknown type: " + soln.type);

  if (myMax > 1) // preserve important associations:
    // map: e.g. [[1,2],[3,4]]
    // [walk(soln.solutions[0]), walk(soln.solutions[1]),...]
    return soln.solutions.map(walk);
  else // hide unimportant nesting:
    // flatmap: e.g. [1,2,3,4]
    // [].concat(walk(soln.solutions[0])).concat(walk(soln.solutions[1]))...
    return [].concat.apply([], soln.solutions.map(walk));
}

function binder (tree) {
  var stack = []; // e.g. [2, 1] for v="http://shex.io/extensions/Map/#BPDAM-XXX"
  //
  function getter (v) {
    // work with copy of stack while trying to grok this problem...
    var nextStack = stack.slice();
    var next = diveIntoObj(nextStack); // no effect if in obj
    while (!(v in next)) {
      var last;
      while(next.constructor !== Array) {
        last = nextStack.pop();
        next = getObj(nextStack);
      }
      nextStack.push(last+1);
      next = diveIntoObj(nextStack);
      // throw Error ("can't advance to find " + v + " in " + JSON.stringify(next));
    }
    stack = nextStack.slice();
    return next[v];

    function getObj (s) {
      return s.reduce(function (res, elt) {
        return res[elt];
      }, tree);
    }

    function diveIntoObj (s) {
      while (getObj(s).constructor === Array)
        s.push(0);
      return getObj(s);
    }
  };
  return {get: getter};
}

var iface = {
  register: register,
  done: done,
  materializer: materializer,
  binder: binder,
  url: MapExt,
  visitTripleConstraint: myvisitTripleConstraint
};

if (typeof require !== 'undefined' && typeof exports !== 'undefined')
  module.exports = iface;
else
  ShExMap = iface;
