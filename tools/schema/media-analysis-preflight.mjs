/** Authoritative shared compiler preflight. No target source is emitted before this succeeds. */
const annotations = ["$schema", "$id", "$defs", "title", "description"];
export const keywordMatrix = {
  string: ["type", "minLength", "maxLength", "pattern"],
  number: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
  integer: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
  boolean: ["type"],
  array: ["type", "items", "minItems", "maxItems"],
  object: [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "x-editagent-checks",
  ],
  $ref: ["$ref", "description"],
  oneOf: ["oneOf"],
  allOf: ["allOf"],
  const: ["const"],
  enum: ["enum"],
};
const counts = ["minLength", "maxLength", "minItems", "maxItems", "minProperties"];
const bounds = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
const reserved = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally " +
    "for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
    "arguments eval constructor prototype modelConfig modelFields modelDump validateContract " +
    "Annotated Literal Self TypeAlias Field ContractModel str int float bool list partial"
  ).split(" "),
);
const ruleParameters = {
  positive: ["field"],
  maximum: ["field", "value"],
  less: ["left", "right"],
  lessEqual: ["left", "right"],
  sameWhenPresent: ["left", "right"],
  together: ["fields"],
  sumMax: ["fields", "maximum"],
  unique: ["field", "key"],
  nestedCount: ["field", "child", "maximum"],
  orderedRanges: ["field", "start", "end"],
  orderedPoints: ["field", "time"],
  rangesWithin: ["field", "lower", "upper", "start", "end"],
  pointsWithin: ["field", "lower", "upper", "time"],
  timesWithin: ["duration", "fields", "timeKeys"],
  rotatedDimensions: ["width", "height", "displayWidth", "displayHeight", "rotation"],
};
const decimalKinds = new Set(["positive", "maximum", "less", "lessEqual"]);
const plain = (v) =>
  v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
function demand(condition, message) {
  if (!condition) throw new Error(`Schema preflight: ${message}`);
}
function number(value, label) {
  demand(
    typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER,
    `${label} must be a finite portable JSON number`,
  );
}
function count(value, label) {
  demand(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`);
}
function identifier(value, type = false) {
  demand(
    typeof value === "string" &&
      (type ? /^[A-Z][A-Za-z0-9]*$/ : /^[a-z][A-Za-z0-9]*$/).test(value) &&
      !reserved.has(value),
    "Nonportable generated identifier",
  );
}
function strings(value, label) {
  demand(
    Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === "string" && v.length > 0) &&
      new Set(value).size === value.length,
    `${label} must be a nonempty unique string array`,
  );
}

/** Deliberately ASCII regex grammar; no engine-dependent classes, wildcards or lookarounds.
 * The exact Unicode-surrogate exclusion and absolute-end idiom are supported explicitly.
 * The legacy MediaTime expression is retained unchanged (its newline policy is separate debt).
 */
function portablePattern(pattern) {
  demand(typeof pattern === "string", "pattern must be a string");
  if (pattern === "^[^\\ud800-\\udfff]*$(?![\\s\\S])" || pattern === "^(0|[1-9][0-9]*)$") return;
  demand(pattern.startsWith("^") && pattern.endsWith("$(?![\\s\\S])"), "Nonportable regex anchors");
  const body = pattern.slice(1, -"$(?![\\s\\S])".length);
  let inClass = false;
  let classCharacters = 0;
  for (const c of body) {
    demand(
      c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126 && c !== "\\",
      "Nonportable regex syntax",
    );
    if (c === "[") {
      demand(!inClass, "Nonportable regex class");
      inClass = true;
      classCharacters = 0;
    } else if (c === "]") {
      demand(inClass && classCharacters > 0, "Nonportable regex class");
      inClass = false;
    } else if (inClass) {
      demand(/[A-Za-z0-9._+^,-]/.test(c), "Nonportable regex class");
      if (c !== "^") classCharacters++;
    } else demand(/[A-Za-z0-9()|*+{},-]/.test(c), "Nonportable regex syntax");
  }
  demand(!inClass, "Nonportable regex class");
  for (const token of body.matchAll(/\{[^}]*\}/g)) {
    const match = /^\{([0-9]+)(?:,([0-9]+))?\}$/.exec(token[0]);
    demand(match !== null, "Nonportable regex repetition syntax");
    const min = Number(match[1]);
    const max = Number(match[2] ?? match[1]);
    demand(
      Number.isSafeInteger(min) && Number.isSafeInteger(max) && min <= max && max <= 2_147_483_647,
      "Nonportable regex repetition bound",
    );
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new Error("Schema preflight: Invalid portable regex");
  }
}

export function preflight(schemas, nodes, referenced) {
  const visited = new Set();
  const active = new Set();
  const ownerOf = (node, fallback) => nodes.get(node)?.owner ?? fallback;
  function alternatives(node, owner) {
    if (node.$ref) {
      const target = referenced(node.$ref, owner);
      return alternatives(target, ownerOf(target, owner));
    }
    if (node.oneOf) return node.oneOf.flatMap((n) => alternatives(n, owner));
    return [{ node, owner }];
  }
  function effective(node, owner) {
    if (node.$ref) {
      const target = referenced(node.$ref, owner);
      return effective(target, ownerOf(target, owner));
    }
    if (node.allOf) return "string";
    if (node.const !== undefined)
      return typeof node.const === "number" ? "integer" : typeof node.const;
    if (node.enum) return typeof node.enum[0] === "number" ? "integer" : typeof node.enum[0];
    return node.type;
  }
  function decimalText(node, owner) {
    if (node.$ref) {
      const target = referenced(node.$ref, owner);
      return decimalText(target, ownerOf(target, owner));
    }
    if (node.allOf) return node.allOf.some((n) => decimalText(n, owner));
    return (
      node.type === "string" &&
      ["^(0|[1-9][0-9]*)$", "^(0|[1-9][0-9]*)$(?![\\s\\S])"].includes(node.pattern)
    );
  }
  function path(contexts, value, expected, required = false) {
    demand(
      typeof value === "string" && /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/.test(value),
      "Invalid rule path",
    );
    let found = contexts;
    for (const part of value.split(".")) {
      const branches = found.flatMap(({ node, owner }) => alternatives(node, owner));
      if (required)
        demand(
          branches.every(({ node }) => node.type === "object" && node.required?.includes(part)),
          "Rule operand must be required",
        );
      found = branches
        .filter(({ node }) => node.type === "object" && Object.hasOwn(node.properties, part))
        .map(({ node, owner }) => ({ node: node.properties[part], owner }));
      demand(found.length > 0, "Invalid rule path: field does not exist");
    }
    if (expected)
      demand(
        found.every(({ node, owner }) => expected.includes(effective(node, owner))),
        "Invalid rule path type",
      );
    return found;
  }
  function arrayItems(contexts, value) {
    return path(contexts, value, ["array"])
      .flatMap(({ node, owner }) => alternatives(node, owner))
      .map(({ node, owner }) => ({ node: node.items, owner }));
  }
  function checkRules(node, owner) {
    const rules = node["x-editagent-checks"];
    demand(
      node.type === "object" && Array.isArray(rules),
      "Rules require an object node and an array",
    );
    const context = [{ node, owner }];
    for (const rule of rules) {
      demand(
        plain(rule) && typeof rule.kind === "string" && Object.hasOwn(ruleParameters, rule.kind),
        "Unsupported contract rule",
      );
      const keys = ruleParameters[rule.kind];
      demand(
        keys.every((k) => Object.hasOwn(rule, k)),
        "Missing rule parameter",
      );
      demand(
        Object.keys(rule).every(
          (k) =>
            k === "kind" || keys.includes(k) || (k === "decimal" && decimalKinds.has(rule.kind)),
        ),
        "Unsupported rule parameter",
      );
      if (Object.hasOwn(rule, "decimal"))
        demand(typeof rule.decimal === "boolean", "decimal must be boolean");
      const numeric = rule.decimal === true ? ["string"] : ["number", "integer"];
      const numericPath = (field, required = false) => {
        const resolved = path(context, field, numeric, required);
        if (rule.decimal === true)
          demand(
            resolved.every(({ node: n, owner: o }) => decimalText(n, o)),
            "Decimal rule operands require canonical decimal strings",
          );
      };
      switch (rule.kind) {
        case "positive":
        case "maximum":
          numericPath(rule.field);
          if (rule.kind === "maximum") {
            if (rule.decimal === true)
              demand(
                typeof rule.value === "string" && /^(0|[1-9][0-9]*)$(?![\s\S])/.test(rule.value),
                "Invalid decimal rule bound",
              );
            else number(rule.value, "rule value");
          }
          break;
        case "less":
        case "lessEqual":
          numericPath(rule.left, true);
          numericPath(rule.right, true);
          break;
        case "sameWhenPresent": {
          const left = path(context, rule.left);
          const right = path(context, rule.right);
          const types = [...left, ...right].map(({ node: n, owner: o }) => effective(n, o));
          demand(
            types.every((t) => ["string", "number", "integer", "boolean"].includes(t)) &&
              new Set(types).size === 1,
            "Equality rule requires matching scalar types",
          );
          break;
        }
        case "together":
        case "sumMax":
          strings(rule.fields, "fields");
          for (const f of rule.fields)
            path(
              context,
              f,
              rule.kind === "sumMax" ? ["number", "integer"] : undefined,
              rule.kind === "sumMax",
            );
          if (rule.kind === "sumMax") number(rule.maximum, "rule maximum");
          break;
        case "unique":
          path(arrayItems(context, rule.field), rule.key, [
            "string",
            "number",
            "integer",
            "boolean",
          ]);
          break;
        case "nestedCount":
          path(arrayItems(context, rule.field), rule.child, ["array"]);
          count(rule.maximum, "rule maximum");
          break;
        case "orderedRanges":
        case "rangesWithin":
        case "orderedPoints":
        case "pointsWithin": {
          const items = arrayItems(context, rule.field);
          if (rule.kind.endsWith("Ranges") || rule.kind === "rangesWithin") {
            path(items, rule.start, ["string"]);
            path(items, rule.end, ["string"]);
          } else path(items, rule.time, ["string"]);
          if (rule.kind.endsWith("Within")) {
            path(context, rule.lower, ["string"]);
            path(context, rule.upper, ["string"]);
          }
          break;
        }
        case "rotatedDimensions":
          for (const k of keys) path(context, rule[k], ["integer"]);
          break;
        case "timesWithin": {
          path(context, rule.duration, ["string"]);
          strings(rule.fields, "fields");
          strings(rule.timeKeys, "timeKeys");
          const reached = new Set();
          const seen = new Set();
          function descend(n, o) {
            for (const { node: v, owner: w } of alternatives(n, o)) {
              if (seen.has(v)) continue;
              seen.add(v);
              if (v.type === "object")
                for (const [key, child] of Object.entries(v.properties)) {
                  if (rule.timeKeys.includes(key)) {
                    demand(effective(child, w) === "string", "Invalid timeKeys type");
                    reached.add(key);
                  } else descend(child, w);
                }
              else if (v.type === "array") descend(v.items, w);
            }
          }
          for (const f of rule.fields)
            for (const { node: n, owner: o } of path(context, f, ["object", "array"]))
              descend(n, o);
          demand(
            rule.timeKeys.every((k) => reached.has(k)),
            "Invalid rule path: timeKeys do not exist",
          );
          break;
        }
      }
    }
  }
  function visit(node, owner, location = "root") {
    demand(plain(node), "Schema nodes must be plain objects");
    if (visited.has(node)) return;
    demand(!active.has(node), "Recursive contracts are not supported");
    active.add(node);
    for (const k of counts) if (Object.hasOwn(node, k)) count(node[k], k);
    for (const k of bounds) if (Object.hasOwn(node, k)) number(node[k], k);
    for (const [min, max] of [
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
    ])
      if (Object.hasOwn(node, min) && Object.hasOwn(node, max))
        demand(node[min] <= node[max], "Impossible count range");
    const lower = Math.max(node.minimum ?? -Infinity, node.exclusiveMinimum ?? -Infinity);
    const upper = Math.min(node.maximum ?? Infinity, node.exclusiveMaximum ?? Infinity);
    const openLower = lower === node.exclusiveMinimum;
    const openUpper = upper === node.exclusiveMaximum;
    demand(
      lower < upper || (lower === upper && !openLower && !openUpper),
      "Impossible numeric range",
    );
    if (node.type === "integer")
      demand(
        (openLower && Number.isInteger(lower) ? lower + 1 : Math.ceil(lower)) <=
          (openUpper && Number.isInteger(upper) ? upper - 1 : Math.floor(upper)),
        "Impossible integer range",
      );
    const forms = ["$ref", "oneOf", "allOf", "const", "enum"].filter((k) => Object.hasOwn(node, k));
    demand(
      forms.length <= 1 && !(forms.length && Object.hasOwn(node, "type")),
      "Ambiguous schema form",
    );
    const form = forms[0] ?? node.type;
    demand(
      typeof form === "string" && Object.hasOwn(keywordMatrix, form),
      "Unsupported schema shape",
    );
    const permitted = new Set([
      ...keywordMatrix[form],
      ...(form === "$ref"
        ? []
        : form === "allOf"
          ? annotations.filter((k) => k !== "$defs")
          : annotations),
    ]);
    for (const key of Object.keys(node))
      demand(
        permitted.has(key),
        form === "allOf"
          ? "Unsupported scalar intersection constraint"
          : `Unsupported schema keyword: ${key} on ${form}`,
      );
    for (const key of ["title", "description", "$id", "$schema"])
      if (Object.hasOwn(node, key))
        demand(typeof node[key] === "string", `${key} must be a string`);
    if (Object.hasOwn(node, "$schema"))
      demand(
        node.$schema === "https://json-schema.org/draft/2020-12/schema",
        "Unsupported JSON Schema draft",
      );
    if (Object.hasOwn(node, "$defs")) {
      demand(location === "root" && plain(node.$defs), "$defs supported only on document roots");
      for (const [name, child] of Object.entries(node.$defs)) {
        identifier(
          name.replace(/^./, (c) => c.toUpperCase()),
          true,
        );
        visit(child, owner, "definition");
      }
    }
    if (nodes.has(node)) identifier(nodes.get(node).name, true);
    if (form === "$ref") {
      demand(typeof node.$ref === "string", "$ref must be a string");
      const target = referenced(node.$ref, owner);
      visit(target, ownerOf(target, owner), "reference");
    } else if (form === "const" || form === "enum") {
      const values = form === "const" ? [node.const] : node.enum;
      demand(
        Array.isArray(values) &&
          values.length > 0 &&
          values.every((v) => ["string", "number", "boolean"].includes(typeof v)) &&
          new Set(values.map((v) => typeof v)).size === 1 &&
          new Set(values).size === values.length,
        "Only homogeneous primitive literals are supported",
      );
      for (const v of values) {
        if (typeof v === "number") {
          number(v, "literal");
          demand(Number.isSafeInteger(v), "Numeric literals must be safe integers");
        }
        if (typeof v === "string") demand(!/[\uD800-\uDFFF]/u.test(v), "Ill-formed literal string");
      }
    } else if (form === "allOf") {
      demand(Array.isArray(node.allOf) && node.allOf.length > 0, "allOf must be nonempty");
      const leaves = [];
      function leaf(n, o) {
        if (n.$ref) {
          const target = referenced(n.$ref, o);
          leaf(target, ownerOf(target, o));
        } else if (n.allOf) for (const child of n.allOf) leaf(child, o);
        else {
          demand(
            n.type === "string" &&
              Object.keys(n).every((k) =>
                [
                  "type",
                  "minLength",
                  "maxLength",
                  "pattern",
                  "$schema",
                  "$id",
                  "title",
                  "description",
                ].includes(k),
              ),
            "Unsupported scalar intersection constraint",
          );
          leaves.push(n);
        }
      }
      for (const child of node.allOf) {
        visit(child, owner, "intersection");
        leaf(child, owner);
      }
      demand(
        Math.max(...leaves.map((n) => n.minLength ?? 0)) <=
          Math.min(...leaves.map((n) => n.maxLength ?? Infinity)),
        "Impossible scalar intersection range",
      );
    } else if (form === "oneOf") {
      demand(
        Array.isArray(node.oneOf) && node.oneOf.length >= 2,
        "oneOf must contain disjoint status references",
      );
      const statuses = [];
      for (const child of node.oneOf) {
        demand(plain(child) && typeof child.$ref === "string", "oneOf only supports references");
        visit(child, owner, "union");
        const branch = referenced(child.$ref, owner);
        demand(
          branch.type === "object" &&
            branch.required?.includes("status") &&
            typeof branch.properties?.status?.const === "string",
          "oneOf requires a required literal status",
        );
        statuses.push(branch.properties.status.const);
      }
      demand(new Set(statuses).size === statuses.length, "oneOf status branches must be disjoint");
    } else if (form === "string" && Object.hasOwn(node, "pattern")) portablePattern(node.pattern);
    else if (form === "array") {
      demand(plain(node.items), "Array items must be a supported schema");
      demand(
        node.items.type !== "object",
        "Inline object array items are unsupported; use a registered reference",
      );
      visit(node.items, owner, "items");
    } else if (form === "object") {
      demand(
        node.additionalProperties === false && plain(node.properties) && nodes.has(node),
        "Contracts require registered strict objects",
      );
      if (Object.hasOwn(node, "required")) {
        demand(
          Array.isArray(node.required) &&
            node.required.every(
              (k) => typeof k === "string" && Object.hasOwn(node.properties, k),
            ) &&
            new Set(node.required).size === node.required.length,
          "Invalid required fields",
        );
      }
      if (Object.hasOwn(node, "minProperties"))
        demand(
          node.minProperties <= Object.keys(node.properties).length,
          "Impossible property count",
        );
      for (const [key, child] of Object.entries(node.properties)) {
        identifier(key);
        visit(child, owner, "property");
      }
      if (Object.hasOwn(node, "x-editagent-checks")) checkRules(node, owner);
    }
    active.delete(node);
    visited.add(node);
  }
  for (const schema of schemas) visit(schema, schema);
}
