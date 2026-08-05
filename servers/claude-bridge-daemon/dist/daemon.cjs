#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/index.ts
var import_promises17 = require("node:fs/promises");

// ../../packages/shared/src/atomic-write.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var DEFAULT_RETRIES = 5;
var DEFAULT_RETRY_DELAY_MS = 50;
var RETRYABLE_CODES = /* @__PURE__ */ new Set(["EBUSY", "EPERM", "EACCES", "EEXIST"]);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRetryable(error) {
  if (typeof error !== "object" || error === null) return false;
  const code = error.code;
  return code !== void 0 && RETRYABLE_CODES.has(code);
}
function tempPath(targetPath) {
  const dir = (0, import_node_path.dirname)(targetPath);
  const suffix = (0, import_node_crypto.randomBytes)(8).toString("hex");
  return (0, import_node_path.join)(dir, `.${suffix}.tmp`);
}
async function atomicWrite(targetPath, content, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const encoding = options.encoding ?? "utf-8";
  const ensureDir2 = options.ensureDir ?? true;
  if (ensureDir2) {
    await (0, import_promises.mkdir)((0, import_node_path.dirname)(targetPath), { recursive: true });
  }
  const tmp = tempPath(targetPath);
  try {
    if (typeof content === "string") {
      await (0, import_promises.writeFile)(tmp, content, encoding);
    } else {
      await (0, import_promises.writeFile)(tmp, content);
    }
  } catch (writeErr) {
    await (0, import_promises.unlink)(tmp).catch(() => void 0);
    throw writeErr;
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await (0, import_promises.rename)(tmp, targetPath);
      return;
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === retries) {
        await (0, import_promises.unlink)(tmp).catch(() => void 0);
        throw e;
      }
      const delay = baseDelay * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}
async function atomicWriteJson(targetPath, value, options) {
  const content = `${JSON.stringify(value, null, 2)}
`;
  return atomicWrite(targetPath, content, options);
}

// ../../packages/shared/src/logger.ts
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
var envLevel = process.env["LOG_LEVEL"] || "info";
var minLevel = LEVELS[envLevel] ?? LEVELS.info;
var pretty = process.env["LOG_FORMAT"] === "pretty";
function emit(level, component, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    pid: process.pid,
    component,
    msg,
    ...fields
  };
  const line = pretty ? `[${entry.ts}] ${level.toUpperCase()} pid=${entry.pid} (${component}) ${msg}${fields ? ` ${JSON.stringify(fields)}` : ""}` : JSON.stringify(entry);
  process.stderr.write(`${line}
`);
}
function makeLogger(component) {
  return {
    debug: (m, f) => emit("debug", component, m, f),
    info: (m, f) => emit("info", component, m, f),
    warn: (m, f) => emit("warn", component, m, f),
    error: (m, f) => emit("error", component, m, f),
    child: (c) => makeLogger(`${component}.${c}`)
  };
}

// ../../packages/shared/src/paths.ts
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
function bridgeRoot() {
  return (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude-bridge");
}

// ../../packages/shared/src/control-paths.ts
var import_node_path3 = require("node:path");
function controlDir() {
  return (0, import_node_path3.join)(bridgeRoot(), "control");
}
function daemonLockPath() {
  return (0, import_node_path3.join)(controlDir(), "daemon.lock");
}
function stateFilePath() {
  return (0, import_node_path3.join)(controlDir(), "state.json");
}
function eventsFilePath() {
  return (0, import_node_path3.join)(controlDir(), "events.jsonl");
}
function requestsDir() {
  return (0, import_node_path3.join)(controlDir(), "requests");
}
function requestsDoneDir() {
  return (0, import_node_path3.join)(requestsDir(), "done");
}
function requestPath(requestId) {
  return (0, import_node_path3.join)(requestsDir(), `${requestId}.json`);
}
function requestDonePath(requestId) {
  return (0, import_node_path3.join)(requestsDoneDir(), `${requestId}.json`);
}
function resultsDir() {
  return (0, import_node_path3.join)(controlDir(), "results");
}
function resultPath(requestId) {
  return (0, import_node_path3.join)(resultsDir(), `${requestId}.json`);
}
function teamsDir() {
  return (0, import_node_path3.join)(controlDir(), "teams");
}
function heartbeatPath() {
  return (0, import_node_path3.join)(controlDir(), "heartbeat");
}

// ../../packages/shared/src/reentrancy-guard.ts
function guardReentrancy(fn, options = {}) {
  let inFlight = false;
  let skipped = 0;
  const run = async () => {
    if (inFlight) {
      skipped++;
      options.onSkip?.(skipped);
      return;
    }
    inFlight = true;
    try {
      await fn();
    } catch (e) {
      options.onError?.(e);
    } finally {
      inFlight = false;
      skipped = 0;
    }
  };
  return Object.assign(run, {
    busy: () => inFlight,
    skipped: () => skipped
  });
}
function isPowerOfTwo(n) {
  return n > 0 && (n & n - 1) === 0;
}

// ../../packages/shared/src/inbox-envelope.ts
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");

// ../../node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;

// ../../packages/shared/src/inbox-envelope.ts
var MessageKindSchema = external_exports.enum(["ask", "reply", "broadcast"]);
var MessageEnvelopeSchema = external_exports.object({
  id: external_exports.string().min(1),
  /** Sender peer id. For an external injector, a synthetic label (see `isSyntheticSender`). */
  from: external_exports.string().min(1),
  fromName: external_exports.string().optional(),
  /** Recipient peer id — a sessionId UUID, never a display name. Names the inbox directory. */
  to: external_exports.string().min(1),
  toName: external_exports.string().optional(),
  kind: MessageKindSchema,
  sentAt: external_exports.string(),
  content: external_exports.string(),
  threadId: external_exports.string().optional(),
  inReplyTo: external_exports.string().optional()
}).passthrough();
function generateMessageId(now = Date.now()) {
  return `${now.toString(36)}-${(0, import_node_crypto2.randomBytes)(4).toString("hex")}`;
}
var SYNTHETIC_SENDER_PREFIX = "external:";
function syntheticSenderId(label) {
  return label.startsWith(SYNTHETIC_SENDER_PREFIX) ? label : `${SYNTHETIC_SENDER_PREFIX}${label}`;
}
function inboxPendingDir(peerId, root = bridgeRoot()) {
  return (0, import_node_path4.join)(root, "inbox", peerId, "pending");
}
async function writeEnvelope(envelope, root = bridgeRoot()) {
  const parsed = MessageEnvelopeSchema.parse(envelope);
  const path = (0, import_node_path4.join)(inboxPendingDir(parsed.to, root), `${parsed.id}.json`);
  await atomicWriteJson(path, parsed);
  return path;
}
async function resolvePeer(idOrName, root = bridgeRoot(), now = Date.now()) {
  const dir = (0, import_node_path4.join)(root, "status");
  let files;
  try {
    files = (await (0, import_promises2.readdir)(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { outcome: "not_found" };
  }
  const peers = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await (0, import_promises2.readFile)((0, import_node_path4.join)(dir, file), "utf-8"));
      const id = typeof raw["id"] === "string" ? raw["id"] : null;
      const name = typeof raw["name"] === "string" ? raw["name"] : null;
      if (!id || !name) continue;
      const lastSeen = typeof raw["lastSeen"] === "string" ? Date.parse(raw["lastSeen"]) : Number.NaN;
      peers.push({
        id,
        name,
        ...typeof raw["displayName"] === "string" ? { displayName: raw["displayName"] } : {},
        lastSeenAgeMs: Number.isNaN(lastSeen) ? Number.POSITIVE_INFINITY : now - lastSeen
      });
    } catch {
    }
  }
  const byId = peers.find((p) => p.id === idOrName);
  if (byId) return { outcome: "found", peer: byId };
  const byName = peers.filter((p) => p.name === idOrName || p.displayName === idOrName);
  if (byName.length === 1 && byName[0]) return { outcome: "found", peer: byName[0] };
  if (byName.length > 1) return { outcome: "ambiguous", candidates: byName };
  return { outcome: "not_found" };
}

// package.json
var package_default = {
  name: "claude-bridge-daemon",
  version: "0.10.18",
  private: true,
  description: "Control-plane daemon for the claude-bridge plugin: peer lifecycle, telemetry, audit. Distributed as opt-in artefact \u2014 see ADR-008.",
  type: "module",
  main: "dist/daemon.cjs",
  bin: {
    "claude-bridge-daemon": "dist/daemon.cjs"
  },
  scripts: {
    build: "esbuild src/index.ts --bundle --platform=node --target=node18 --format=cjs --outfile=dist/daemon.cjs --banner:js='#!/usr/bin/env node' --loader:.json=json && mkdir -p templates && cp src/templates/claude-bridge-daemon.service templates/",
    dev: "tsx --watch src/index.ts",
    start: "node dist/daemon.cjs",
    test: "vitest run tests/",
    "test:watch": "vitest tests/",
    typecheck: "tsc --noEmit",
    check: "biome check src tests"
  },
  dependencies: {
    "@claude-bridge/shared": "*",
    zod: "^3.23.8"
  },
  devDependencies: {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "^22.9.0",
    esbuild: "^0.24.0",
    tsx: "^4.19.2",
    typescript: "^5.6.3",
    vitest: "^2.1.8"
  },
  engines: {
    node: ">=18"
  }
};

// src/events.ts
var import_promises3 = require("node:fs/promises");
var import_node_path5 = require("node:path");
var log = makeLogger("daemon.events");
var EVENTS_SCHEMA_VERSION = 1;
var ensured = false;
async function ensureDir() {
  if (ensured) return;
  await (0, import_promises3.mkdir)((0, import_node_path5.dirname)(eventsFilePath()), { recursive: true });
  ensured = true;
}
var EVENTS_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
var EVENTS_KEEP_ROTATIONS = 3;
function eventsMaxBytes() {
  const raw = process.env["CLAUDE_BRIDGE_EVENTS_MAX_BYTES"];
  if (!raw) return EVENTS_MAX_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : EVENTS_MAX_BYTES_DEFAULT;
}
var liveBytes = -1;
async function rotateIfNeeded(pendingBytes) {
  const path = eventsFilePath();
  const maxBytes = eventsMaxBytes();
  if (liveBytes < 0) {
    try {
      liveBytes = (await (0, import_promises3.stat)(path)).size;
    } catch {
      liveBytes = 0;
    }
  }
  if (liveBytes + pendingBytes <= maxBytes) {
    liveBytes += pendingBytes;
    return;
  }
  for (let i = EVENTS_KEEP_ROTATIONS - 1; i >= 1; i--) {
    await (0, import_promises3.rename)(`${path}.${i}`, `${path}.${i + 1}`).catch(() => void 0);
  }
  try {
    await (0, import_promises3.rename)(path, `${path}.1`);
    liveBytes = pendingBytes;
    log.info("events_rotated", { keep: EVENTS_KEEP_ROTATIONS, maxBytes });
  } catch (e) {
    liveBytes = 0;
    log.warn("events_rotate_failed", { err: String(e) });
  }
}
var writeChain = Promise.resolve();
async function writeEvent(evt) {
  const run = writeChain.then(() => writeEventInner(evt));
  writeChain = run.catch(() => void 0);
  return run;
}
async function writeEventInner(evt) {
  try {
    await ensureDir();
    const wire = {
      schemaVersion: EVENTS_SCHEMA_VERSION,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      pid: process.pid,
      level: evt.level ?? "info",
      event: evt.event,
      by: evt.by ?? null,
      requestId: evt.requestId ?? null,
      details: evt.details ?? {}
    };
    const line = `${JSON.stringify(wire)}
`;
    await rotateIfNeeded(Buffer.byteLength(line, "utf-8"));
    await (0, import_promises3.appendFile)(eventsFilePath(), line, "utf-8");
  } catch (e) {
    log.error("event_write_failed", { event: evt.event, err: String(e) });
  }
}
async function writeDaemonEvent(event, details = {}, level = "info") {
  await writeEvent({
    event,
    level,
    by: { sessionId: null, name: "daemon" },
    details
  });
}

// src/rpc.ts
var import_promises4 = require("node:fs/promises");
var log2 = makeLogger("daemon.rpc");
var REQUEST_SCHEMA_VERSION = 1;
async function ensureRpcDirs() {
  await (0, import_promises4.mkdir)(requestsDir(), { recursive: true });
  await (0, import_promises4.mkdir)(requestsDoneDir(), { recursive: true });
  await (0, import_promises4.mkdir)(resultsDir(), { recursive: true });
}
async function listPendingRequests() {
  try {
    const files = await (0, import_promises4.readdir)(requestsDir());
    return files.filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return [];
    log2.warn("requests_list_error", { err: String(e) });
    return [];
  }
}
async function readRequest(fileName) {
  const requestId = fileName.replace(/\.json$/, "");
  try {
    const raw = await (0, import_promises4.readFile)(requestPath(requestId), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.id || !parsed.tool) {
      log2.warn("request_invalid_shape", { fileName });
      return null;
    }
    return parsed;
  } catch (e) {
    log2.warn("request_read_error", { fileName, err: String(e) });
    return null;
  }
}
async function markRequestDone(requestId) {
  try {
    await (0, import_promises4.rename)(requestPath(requestId), requestDonePath(requestId));
    return true;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return true;
    log2.warn("request_mark_done_failed", { requestId, err: String(e) });
    return false;
  }
}
async function writeResult(res) {
  await atomicWriteJson(resultPath(res.id), res);
}
function okResult(id, tool, data) {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "ok",
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    data
  };
}
function errResult(id, tool, code, message, details) {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id,
    tool,
    outcome: "error",
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    error: { code, message, details }
  };
}

// src/handlers/control-status.ts
async function handleControlStatus(req, ctx) {
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    daemonStartedAt: ctx.state.daemonStartedAt,
    stateVersion: ctx.state.stateVersion,
    peerCount: Object.keys(ctx.state.peers).length,
    hostDriver: ctx.hostDriver.name
  });
}

// src/handlers/peer-compact.ts
var import_node_crypto4 = require("node:crypto");
var import_promises6 = require("node:fs/promises");
var import_node_path7 = require("node:path");

// src/event-subscribers.ts
var import_node_crypto3 = require("node:crypto");
var import_promises5 = require("node:fs/promises");
var import_node_path6 = require("node:path");
var log3 = makeLogger("daemon.subscribers");
function subscribersFilePath() {
  return (0, import_node_path6.join)(controlDir(), "subscribers.json");
}
function inboxPendingDir2(peerId) {
  return (0, import_node_path6.join)(bridgeRoot(), "inbox", peerId, "pending");
}
async function readSubscribers() {
  try {
    const raw = await (0, import_promises5.readFile)(subscribersFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.subscribers ?? [];
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return [];
    log3.warn("subscribers_read_error", { err: String(e) });
    return [];
  }
}
function generateMsgId() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto3.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function publishLifecycleEvent(payload) {
  const subscribers = await readSubscribers();
  const interested = subscribers.filter((s) => s.events.includes(payload.event));
  if (interested.length === 0) return;
  for (const sub of interested) {
    const msgId = generateMsgId();
    const envelope = {
      id: msgId,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
      to: { sessionId: sub.peerId, name: sub.peerId },
      kind: "lifecycle-event",
      content: {
        event: payload.event,
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        details: payload.details
      }
    };
    try {
      const path = (0, import_node_path6.join)(inboxPendingDir2(sub.peerId), `${msgId}.json`);
      await atomicWriteJson(path, envelope);
    } catch (e) {
      log3.warn("subscriber_dispatch_failed", {
        subscriber: sub.peerId,
        event: payload.event,
        err: String(e)
      });
    }
  }
}

// src/handlers/peer-ref.ts
function shortFormOf(record) {
  const team = record.team;
  if (!team) return null;
  const prefix = `${team}-`;
  if (!record.name.startsWith(prefix)) return null;
  const short = record.name.slice(prefix.length);
  return short.length > 0 ? short : null;
}
function resolvePeerRef(peers, ref, callerTeam) {
  const byId = peers[ref];
  if (byId) return { kind: "found", sessionId: ref, record: byId };
  const exact = Object.entries(peers).filter(([, rec]) => rec.name === ref);
  if (exact.length === 1) {
    const [sessionId, record] = exact[0];
    return { kind: "found", sessionId, record };
  }
  if (exact.length > 1) return ambiguous(exact);
  const short = Object.entries(peers).filter(([, rec]) => shortFormOf(rec) === ref);
  if (short.length === 0) return { kind: "not_found" };
  if (short.length === 1) {
    const [sessionId, record] = short[0];
    return { kind: "found", sessionId, record };
  }
  if (callerTeam) {
    const own = short.filter(([, rec]) => rec.team === callerTeam);
    if (own.length === 1) {
      const [sessionId, record] = own[0];
      return { kind: "found", sessionId, record };
    }
  }
  return ambiguous(short);
}
function ambiguous(matches) {
  return {
    kind: "ambiguous",
    candidates: matches.map(([sessionId, rec]) => ({
      sessionId,
      name: rec.name,
      tmuxTarget: rec.tmuxTarget,
      status: rec.status
    }))
  };
}
function ambiguousPeerMessage(ref, candidates) {
  const distinctNames = new Set(candidates.map((c) => c.name));
  const list = distinctNames.size === candidates.length ? candidates.map((c) => c.name).join(", ") : candidates.map((c) => `${c.name} [${c.sessionId}]`).join(", ");
  return `'${ref}' matches ${candidates.length} peers \u2014 refusing to guess which one. Use the full name: ${list}`;
}

// src/handlers/peer-compact.ts
var DEFAULT_ANCHOR_TIMEOUT_MS = 3e4;
var DEFAULT_ACK_POLL_MS = 500;
var COMPACT_ACK_FILENAME_EXTENSION = ".json";
var PeerCompactArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  anchorTimeoutMs: external_exports.number().int().positive().max(3e5).optional(),
  ackPollMs: external_exports.number().int().positive().max(1e4).optional(),
  /** Skip the anchor request → treat the ack file as pre-existing. */
  skipAnchorRequest: external_exports.boolean().default(false),
  reason: external_exports.string().optional()
}).strict();
function compactAckDir() {
  return (0, import_node_path7.join)(controlDir(), "compact-ack");
}
function compactAckPath(sessionId) {
  return (0, import_node_path7.join)(compactAckDir(), `${sessionId}${COMPACT_ACK_FILENAME_EXTENSION}`);
}
function inboxPendingDir3(peerId) {
  return (0, import_node_path7.join)(bridgeRoot(), "inbox", peerId, "pending");
}
function generateMsgId2() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto4.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function fileExists(path) {
  try {
    await (0, import_promises6.access)(path);
    return true;
  } catch {
    return false;
  }
}
async function pollForAck(sessionId, deadline, pollMs) {
  const path = compactAckPath(sessionId);
  while (Date.now() < deadline) {
    if (await fileExists(path)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fileExists(path);
}
async function consumeAckFile(sessionId) {
  const src = compactAckPath(sessionId);
  const done = (0, import_node_path7.join)(compactAckDir(), "done");
  try {
    await (0, import_promises6.mkdir)(done, { recursive: true });
    await (0, import_promises6.rename)(src, (0, import_node_path7.join)(done, `${sessionId}-${Date.now()}.json`));
  } catch {
    await (0, import_promises6.unlink)(src).catch(() => void 0);
  }
}
async function writeAnchorRequestMsg(peerId, threadId) {
  const msgId = generateMsgId2();
  const envelope = {
    id: msgId,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: peerId, name: peerId },
    kind: "compact-anchor-request",
    threadId,
    content: {
      instruction: "Write your compact anchor file and touch ~/.claude-bridge/control/compact-ack/<sessionId>.json when ready."
    }
  };
  const path = (0, import_node_path7.join)(inboxPendingDir3(peerId), `${msgId}.json`);
  await atomicWriteJson(path, envelope);
  return msgId;
}
function callerTeamOf(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}
async function handlePeerCompact(req, ctx) {
  const parsed = PeerCompactArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf(req, ctx));
  if (resolved.kind === "ambiguous") {
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates }
    );
  }
  const found = resolved.kind === "found" ? resolved : null;
  if (!found) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer }
    );
  }
  const sessionId = found.sessionId;
  const record = ctx.state.peers[sessionId];
  if (!record) {
    return errResult(req.id, req.tool, "peer_gone", "Peer disappeared before compact started", {
      sessionId
    });
  }
  const sessionKey = record.tmuxTarget ?? record.name;
  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    return errResult(
      req.id,
      req.tool,
      "sendkeys_unsupported",
      `Host driver '${ctx.hostDriver.name}' does not support send-keys on this platform`,
      { hostDriver: ctx.hostDriver.name }
    );
  }
  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const threadId = `compact:${sessionId}:${Date.now().toString(36)}`;
  await (0, import_promises6.mkdir)(compactAckDir(), { recursive: true });
  let anchorMsgId = null;
  if (!args.skipAnchorRequest) {
    try {
      anchorMsgId = await writeAnchorRequestMsg(sessionId, threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, stage: "anchor_request", err: msg }
      });
      return errResult(req.id, req.tool, "anchor_request_write_failed", msg, { sessionId });
    }
    await writeEvent({
      event: "peer_compact_anchor_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, anchorMsgId, timeoutMs: anchorTimeoutMs }
    });
  }
  const deadline = Date.now() + anchorTimeoutMs;
  const acked = await pollForAck(sessionId, deadline, ackPollMs);
  if (!acked) {
    await writeEvent({
      event: "peer_compact_anchor_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, threadId, timeoutMs: anchorTimeoutMs }
    });
    return errResult(
      req.id,
      req.tool,
      "anchor_timeout",
      `Peer '${sessionId}' did not ack anchor within ${anchorTimeoutMs}ms`,
      { sessionId, threadId }
    );
  }
  await writeEvent({
    event: "peer_compact_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId, sessionKey, threadId, injectedKeys: "[daemon] /compact" }
  });
  try {
    await sendKeys(sessionKey, "/compact");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_compact_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, stage: "send_keys", err: msg }
    });
    return errResult(req.id, req.tool, "send_keys_failed", msg, { sessionId, sessionKey });
  }
  await consumeAckFile(sessionId);
  await writeEvent({
    event: "peer_compacted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId, sessionKey, threadId, reason: args.reason ?? null }
  });
  await publishLifecycleEvent({
    event: "peer_compacted",
    sessionId,
    sessionKey,
    details: { threadId, reason: args.reason ?? null }
  });
  return okResult(req.id, req.tool, { sessionId, sessionKey, threadId, anchorMsgId });
}

// src/handlers/peer-restart.ts
var import_node_fs = require("node:fs");
var import_promises8 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path8 = require("node:path");

// src/hosts/driver.ts
var WINDOW_ID = /^@\d+$/;
function parseHostTarget(key) {
  if (WINDOW_ID.test(key)) return { kind: "window", windowId: key };
  return { kind: "session", session: sanitizeSessionKey(key) };
}
function formatHostTarget(t) {
  return t.kind === "window" ? t.windowId : t.session;
}
var UNSAFE_TARGET_CHARS = /[^A-Za-z0-9_-]/g;
function sanitizeSessionKey(rawName) {
  const sanitized = rawName.replace(UNSAFE_TARGET_CHARS, "_");
  if (sanitized.length === 0) {
    throw new Error(`Cannot derive a tmux target from '${rawName}' \u2014 nothing safe remained`);
  }
  return sanitized;
}

// src/env-whitelist.ts
var BASE_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TMPDIR",
  "TMUX",
  "TMUX_PANE",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME"
]);
var HOST_PROVIDED_VARS = Object.freeze(["TERM", "TMUX", "TMUX_PANE"]);
var HARD_STRIP_PREFIXES = Object.freeze([
  "ANTHROPIC_",
  "CLAUDE_",
  "CC_",
  "CLAUDE_CODE_"
]);
function sanitizeEnv(callerEnv, opts = {}) {
  const allow = /* @__PURE__ */ new Set([...BASE_ALLOWLIST, ...opts.extraAllow ?? []]);
  const out = {};
  for (const [key, value] of Object.entries(callerEnv)) {
    if (value === void 0) continue;
    if (!allow.has(key)) continue;
    if (HARD_STRIP_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  if (opts.overrides) {
    for (const [key, value] of Object.entries(opts.overrides)) {
      if (HARD_STRIP_PREFIXES.some((p) => key.startsWith(p)) && !isSpawnEssentialClaudeVar(key)) {
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}
function harvestEnv(callerEnv, opts = {}) {
  return stripHostProvided(sanitizeEnv(callerEnv, opts));
}
function stripHostProvided(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (HOST_PROVIDED_VARS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
function isSpawnEssentialClaudeVar(name) {
  return SPAWN_ESSENTIAL_CLAUDE_VARS.has(name);
}
var SPAWN_ESSENTIAL_CLAUDE_VARS = /* @__PURE__ */ new Set([
  // Points CC at a specific config/credentials profile — the mechanism
  // subscription-based auth uses.
  "CLAUDE_CONFIG_DIR"
]);

// src/handlers/fork-guard.ts
async function forkGuard(state, driver, opts) {
  const record = state.peers[opts.sessionId];
  if (record && (record.status === "live" || record.status === "starting")) {
    return {
      reason: "state_live",
      details: {
        sessionId: opts.sessionId,
        recordedStatus: record.status,
        tmuxTarget: record.tmuxTarget
      }
    };
  }
  if (await driver.hasSession(opts.sessionKey)) {
    return {
      reason: "host_alive",
      details: {
        sessionKey: opts.sessionKey,
        hostDriver: driver.name
      }
    };
  }
  return null;
}

// src/state.ts
var import_promises7 = require("node:fs/promises");
var log4 = makeLogger("daemon.state");
var STATE_VERSION = 1;
var StateVersionMismatch = class extends Error {
  constructor(onDisk, supported) {
    super(
      `state.json stateVersion=${onDisk} exceeds daemon-supported ${supported}; rollback path is not supported \u2014 upgrade or wipe the state file explicitly`
    );
    this.onDisk = onDisk;
    this.supported = supported;
    this.name = "StateVersionMismatch";
  }
};
function emptyState(daemonVersion) {
  return {
    stateVersion: STATE_VERSION,
    daemonVersion,
    daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
    peers: {}
  };
}
function repairHarvestedEnv(peers) {
  for (const record of Object.values(peers)) {
    if (!record.spawnEnv) continue;
    const cleaned = stripHostProvided(record.spawnEnv);
    if (Object.keys(cleaned).length === Object.keys(record.spawnEnv).length) continue;
    log4.info("spawn_env_repaired", {
      sessionId: record.sessionId,
      dropped: HOST_PROVIDED_VARS.filter((v) => v in (record.spawnEnv ?? {}))
    });
    record.spawnEnv = cleaned;
  }
  return peers;
}
async function loadState(daemonVersion) {
  try {
    const raw = await (0, import_promises7.readFile)(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    const onDisk = parsed.stateVersion ?? 0;
    if (onDisk > STATE_VERSION) throw new StateVersionMismatch(onDisk, STATE_VERSION);
    if (onDisk < STATE_VERSION) {
      log4.warn("state_migration_needed", { onDisk, target: STATE_VERSION });
      return emptyState(daemonVersion);
    }
    const doc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
      peers: repairHarvestedEnv(parsed.peers ?? {})
    };
    return doc;
  } catch (e) {
    if (e instanceof StateVersionMismatch) throw e;
    const code = e.code;
    if (code === "ENOENT") {
      log4.info("state_missing_bootstrap");
      return emptyState(daemonVersion);
    }
    log4.error("state_load_error", { err: String(e) });
    throw e;
  }
}
async function saveState(doc) {
  await atomicWriteJson(stateFilePath(), doc);
}

// src/handlers/state-writer.ts
async function applyStateChange(state, mutate) {
  mutate(state);
  await saveState(state);
}

// src/handlers/peer-spawn.ts
var PeerSpawnArgsSchema = external_exports.object({
  sessionId: external_exports.string().min(1).describe("Peer sessionId (UUID for resume; stable name for a new spawn)"),
  displayName: external_exports.string().min(1).describe("Human-visible peer name (also becomes the tmux session name)"),
  cwd: external_exports.string().min(1).describe("Working directory the peer should start in"),
  command: external_exports.string().min(1).describe("Absolute path to `claude` (or another executable for tests)"),
  args: external_exports.array(external_exports.string()).default([]),
  resume: external_exports.boolean().default(false),
  /**
   * Create the peer as a window inside this existing tmux session rather than
   * as a session of its own. `peer_restart` sets it for adopted peers, whose
   * home is a window of a shared session.
   */
  inSession: external_exports.string().min(1).optional(),
  /**
   * Values to build the peer's environment from, instead of the daemon's own.
   * Still filtered by the same whitelist — this changes where the values come
   * from, not which names get through.
   */
  envBase: external_exports.record(external_exports.string()).optional(),
  model: external_exports.string().nullable().optional(),
  accountProfile: external_exports.string().nullable().optional().describe("Name of the account profile under ~/.claude-bridge/control/accounts/"),
  extraAllowEnv: external_exports.array(external_exports.string()).default([]).describe("Additional env var names to pass through beyond the base whitelist"),
  extraEnv: external_exports.record(external_exports.string()).default({}).describe("Fully-formed env overrides (bypass whitelist for these names)")
}).strict();
async function handlePeerSpawn(req, ctx) {
  const parsed = PeerSpawnArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const sessionKey = args.displayName;
  const hit = await forkGuard(ctx.state, ctx.hostDriver, {
    sessionId: args.sessionId,
    sessionKey
  });
  if (hit) {
    await writeEvent({
      event: "peer_spawn_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: args.sessionId, sessionKey, ...hit.details, reason: hit.reason }
    });
    return errResult(
      req.id,
      req.tool,
      "session_already_live",
      `Refusing to spawn \u2014 ${hit.reason === "state_live" ? "daemon state" : "host driver"} still holds sessionId '${args.sessionId}'`,
      { sessionId: args.sessionId, ...hit.details }
    );
  }
  const overrides = { ...args.extraEnv };
  if (args.accountProfile) {
    overrides["CLAUDE_CONFIG_DIR"] = `${process.env["HOME"] ?? ""}/.claude-bridge/control/accounts/${args.accountProfile}`;
  }
  const env = sanitizeEnv(args.envBase ?? process.env, {
    extraAllow: args.extraAllowEnv,
    overrides
  });
  const spawnArgs = [...args.args];
  if (args.resume) {
    spawnArgs.push("--resume", args.sessionId);
  }
  if (args.model) {
    spawnArgs.push("--model", args.model);
  }
  const hostDriverName = ctx.hostDriver.name;
  await applyStateChange(ctx.state, (draft) => {
    draft.peers[args.sessionId] = {
      sessionId: args.sessionId,
      name: args.displayName,
      hostDriver: hostDriverName,
      tmuxTarget: sessionKey,
      pid: null,
      status: "starting",
      // Recorded so peer_restart can put the peer back where it belongs, and
      // launch it the way it was launched, instead of guessing (2026-08-04).
      // `args.args` is the caller's list — NOT spawnArgs, which already has
      // --resume/--model appended and would double them on the next restart.
      cwd: args.cwd,
      command: args.command,
      spawnArgs: args.args,
      // Where this peer belongs, so a later restart does not have to ask a
      // window that may no longer exist.
      ...args.inSession ? { homeSession: args.inSession } : {},
      // `harvestEnv`, not `sanitizeEnv`: `env` above is what this peer starts
      // with, but this is the copy that PERSISTS across restarts, so the
      // pane-scoped vars have to go — they describe a pane that will not be
      // the same one next time.
      ...args.envBase ? { spawnEnv: harvestEnv(args.envBase) } : {},
      model: args.model ?? null,
      accountProfile: args.accountProfile ?? null,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  });
  try {
    const record = await ctx.hostDriver.spawn({
      sessionKey,
      ...args.inSession ? { inSession: args.inSession } : {},
      // Name the window after the peer. tmux otherwise names it after the
      // command, so every window read `claude`.
      windowName: args.displayName,
      cwd: args.cwd,
      command: args.command,
      args: spawnArgs,
      env
    });
    const canonicalKey = record.sessionKey;
    if (!record.alive || record.pid === null) {
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[args.sessionId];
      });
      await ctx.hostDriver.kill(canonicalKey).catch(() => void 0);
      await writeEvent({
        event: "peer_spawn_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          reason: "no_process_after_spawn",
          cwd: args.cwd,
          command: args.command
        }
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_produced_no_process",
        "Host reported the session was created but nothing is running in it \u2014 the command most likely exited immediately (wrong cwd, bad arguments, or missing binary).",
        {
          sessionId: args.sessionId,
          sessionKey: canonicalKey,
          cwd: args.cwd,
          command: args.command
        }
      );
    }
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[args.sessionId];
      if (!rec) return;
      rec.pid = record.pid;
      rec.status = "live";
      rec.tmuxTarget = canonicalKey;
      rec.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
    });
    await writeEvent({
      event: "peer_started",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: args.sessionId,
        sessionKey: canonicalKey,
        rawSessionKey: sessionKey !== canonicalKey ? sessionKey : void 0,
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null
      }
    });
    await publishLifecycleEvent({
      event: "peer_started",
      sessionId: args.sessionId,
      sessionKey: canonicalKey,
      details: {
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null
      }
    });
    return okResult(req.id, req.tool, {
      sessionId: args.sessionId,
      sessionKey: canonicalKey,
      pid: record.pid,
      hostDriver: hostDriverName
    });
  } catch (e) {
    await applyStateChange(ctx.state, (draft) => {
      delete draft.peers[args.sessionId];
    });
    const message = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_spawn_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: args.sessionId, sessionKey, err: message }
    });
    return errResult(req.id, req.tool, "spawn_failed", message, {
      sessionId: args.sessionId,
      sessionKey
    });
  }
}

// src/handlers/peer-stop.ts
var PeerStopArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  reason: external_exports.string().optional(),
  force: external_exports.boolean().default(false),
  /**
   * v0.10.1: keep the peer in state.peers with status:"stopped" instead
   * of deleting it. Used by team_stop so that team_layout apply can
   * resume the same sessionId later. Default false = original delete
   * semantics (backward-compatible with v0.10.0-rc.2 callers).
   */
  keepInState: external_exports.boolean().default(false),
  /**
   * Only meaningful when keepInState:true — sets the resulting
   * PeerRecord.stoppedCleanly. Callers that don't know (plain peer_stop)
   * pass null; team_stop passes true/false based on ack outcome.
   */
  stoppedCleanly: external_exports.boolean().nullable().optional()
}).strict();
function callerTeamOf2(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}
async function handlePeerStop(req, ctx) {
  const parsed = PeerStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf2(req, ctx));
  if (resolved.kind === "ambiguous") {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "ambiguous_peer", candidates: resolved.candidates }
    });
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates }
    );
  }
  const found = resolved.kind === "found" ? resolved : null;
  if (!found) {
    await writeEvent({
      event: "peer_stop_rejected",
      level: "info",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { peer: args.peer, reason: "peer_not_found" }
    });
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer }
    );
  }
  const sessionId = found.sessionId;
  const record = ctx.state.peers[sessionId];
  if (!record) {
    return okResult(req.id, req.tool, { sessionId, alreadyGone: true });
  }
  const sessionKey = record.tmuxTarget ?? record.name;
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[sessionId];
    if (rec) {
      rec.status = "stopping";
      rec.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  });
  const forceFlag = args.force === true;
  try {
    await ctx.hostDriver.kill(sessionKey, { force: forceFlag });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("respawn")) {
      await writeEvent({
        event: "peer_stop_respawn_detected",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { sessionId, sessionKey, err: msg }
      });
      return errResult(req.id, req.tool, "supervisor_respawn", msg, { sessionId, sessionKey });
    }
    await writeEvent({
      event: "peer_stop_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId, sessionKey, err: msg }
    });
    return errResult(req.id, req.tool, "host_kill_failed", msg, { sessionId, sessionKey });
  }
  const keepInState = args.keepInState;
  const stoppedCleanly = keepInState ? args.stoppedCleanly ?? null : void 0;
  await applyStateChange(ctx.state, (draft) => {
    if (keepInState) {
      const rec = draft.peers[sessionId];
      if (rec) {
        rec.status = "stopped";
        rec.stoppedCleanly = stoppedCleanly ?? null;
        rec.pid = null;
        rec.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    } else {
      delete draft.peers[sessionId];
    }
  });
  await writeEvent({
    event: "peer_stopped",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId,
      sessionKey,
      reason: args.reason ?? null,
      force: forceFlag,
      keepInState,
      stoppedCleanly
    }
  });
  await publishLifecycleEvent({
    event: "peer_stopped",
    sessionId,
    sessionKey,
    details: { reason: args.reason ?? null, force: forceFlag, keepInState, stoppedCleanly }
  });
  return okResult(req.id, req.tool, {
    sessionId,
    sessionKey,
    force: forceFlag,
    keepInState,
    stoppedCleanly
  });
}

// src/handlers/peer-restart.ts
var PeerRestartArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  reason: external_exports.string().optional(),
  force: external_exports.boolean().default(false),
  model: external_exports.string().optional(),
  accountProfile: external_exports.string().optional()
}).strict();
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isResumableSessionId(sessionId) {
  return UUID_RE.test(sessionId);
}
async function confirmStillRunning(pid, identity, expectedSessionId, opts = {}) {
  if (pid === null) return { ok: false, reason: "no pid was reported by the spawn" };
  const settleMs = opts.settleMs ?? 2500;
  const procRoot = opts.procRoot ?? "/proc";
  await new Promise((r) => setTimeout(r, settleMs));
  if (!(0, import_node_fs.existsSync)((0, import_node_path8.join)(procRoot, String(pid)))) {
    return { ok: false, reason: `pid ${pid} exited within ${settleMs} ms of starting` };
  }
  const isClaude = (opts.command ?? "").split("/").pop() === "claude";
  if (isClaude && isResumableSessionId(expectedSessionId) && identity.actual === null) {
    return {
      ok: false,
      reason: `pid ${pid} is running but registered no session \u2014 ~/.claude/sessions/${pid}.json never appeared`
    };
  }
  return { ok: true, reason: "alive and registered" };
}
async function verifyRestartedIdentity(expected, pid, opts = {}) {
  if (pid === null || !isResumableSessionId(expected)) return { mismatch: false, actual: null };
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 500;
  const home = opts.homeDir ?? (0, import_node_os2.homedir)();
  const path = (0, import_node_path8.join)(home, ".claude", "sessions", `${pid}.json`);
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = JSON.parse(await (0, import_promises8.readFile)(path, "utf-8"));
      const actual = typeof raw.sessionId === "string" ? raw.sessionId : null;
      if (actual) return { mismatch: actual !== expected, actual };
    } catch {
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { mismatch: false, actual: null };
}
async function markNotRunning(ctx, sessionId) {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[sessionId];
    if (!rec) return;
    rec.status = "unknown";
    rec.pid = null;
    rec.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
}
function callerTeamOf3(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}
async function handlePeerRestart(req, ctx) {
  const parsed = PeerRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf3(req, ctx));
  if (resolved.kind === "ambiguous") {
    return errResult(
      req.id,
      req.tool,
      "ambiguous_peer",
      ambiguousPeerMessage(args.peer, resolved.candidates),
      { peer: args.peer, candidates: resolved.candidates }
    );
  }
  const record = resolved.kind === "found" ? resolved.record : null;
  if (!record) {
    return errResult(
      req.id,
      req.tool,
      "peer_not_found",
      `No peer with id/name '${args.peer}' in daemon state`,
      { peer: args.peer }
    );
  }
  let inSession = record.homeSession ?? null;
  if (inSession === null && record.tmuxTarget && parseHostTarget(record.tmuxTarget).kind === "window") {
    const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
    inSession = windows.find((w) => w.target === record.tmuxTarget)?.session ?? null;
    if (inSession === null) {
      await writeEvent({
        event: "peer_restart_window_home_unknown",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          sessionId: record.sessionId,
          tmuxTarget: record.tmuxTarget,
          hint: "The window is not on the host, so its parent session cannot be read. The peer will be relaunched as a session of its own."
        }
      });
    }
  }
  const provenance = {
    ...record.team !== void 0 ? { team: record.team } : {},
    ...record.adopted !== void 0 ? { adopted: record.adopted } : {},
    ...inSession ? { homeSession: inSession } : {},
    ...record.spawnEnv ? { spawnEnv: record.spawnEnv } : {}
  };
  const stopArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: record.sessionId,
      reason: args.reason ?? "peer_restart",
      force: args.force
    },
    requestedBy: req.requestedBy
  };
  const stopResult = await handlePeerStop(stopArgs, ctx);
  if (stopResult.outcome === "error") {
    return errResult(
      req.id,
      req.tool,
      "restart_stop_failed",
      stopResult.error?.message ?? "peer_stop failed",
      { stopResult }
    );
  }
  const cwd = record.cwd ?? process.cwd();
  const command = record.command ?? "claude";
  const commandArgs = record.spawnArgs ?? [];
  const missing = [record.cwd ? null : "cwd", record.command ? null : "command"].filter(
    (f) => f !== null
  );
  if (missing.length > 0) {
    await writeEvent({
      event: "peer_restart_launch_params_unknown",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: record.sessionId,
        missing,
        fallbackCwd: cwd,
        fallbackCommand: command,
        hint: "Peer record predates launch-parameter persistence (v0.10.3). The restart uses the daemon's cwd and a bare `claude`, which fails on installs where claude is not on the daemon's PATH (nvm). Re-spawn the peer to record its real parameters."
      }
    });
  }
  const spawnArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:spawn`,
    ts: req.ts,
    tool: "peer_spawn",
    args: {
      sessionId: record.sessionId,
      displayName: record.name,
      cwd,
      // The test override stays ahead of the record so the acceptance suite can
      // relaunch something cheaper than a real Claude Code.
      command: process.env["CLAUDE_BRIDGE_TEST_COMMAND"] ?? command,
      args: commandArgs,
      ...inSession ? { inSession } : {},
      // The peer's own environment. Without it the relaunch inherits the
      // daemon's PATH and comes up unable to find node.
      ...record.spawnEnv ? { envBase: record.spawnEnv } : {},
      // Only resume something that CAN be resumed.
      //
      // This was an unconditional `true`. For a peer spawned under a stable
      // name rather than a UUID — `obetni-w3` — that composes
      // `claude --resume obetni-w3`, which matches no transcript, so Claude
      // Code drops into its interactive Resume picker and sits there. The peer
      // is then wedged at a prompt, gets a brand-new session id, and the record
      // is orphaned: the pid matches, so `team_status` still reads "live".
      // Found by plt-designer in the v0.10.6 pilot; the restart reported `ok`
      // over it, which is this release's own defect wearing a new hat.
      resume: isResumableSessionId(record.sessionId),
      model: args.model ?? record.model ?? null,
      accountProfile: args.accountProfile ?? record.accountProfile ?? null,
      extraAllowEnv: [],
      extraEnv: {}
    },
    requestedBy: req.requestedBy
  };
  const spawnResult = await handlePeerSpawn(spawnArgs, ctx);
  if (spawnResult.outcome === "error") {
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[record.sessionId] = {
        ...record,
        status: "unknown",
        pid: null,
        lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    });
    await writeEvent({
      event: "peer_restart_record_retained",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: record.sessionId,
        status: "unknown",
        hint: "The relaunch failed. The record is kept so the peer can be retried or released; nothing is running behind it."
      }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_spawn_failed",
      spawnResult.error?.message ?? "peer_spawn failed",
      { spawnResult }
    );
  }
  if (Object.keys(provenance).length > 0) {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[record.sessionId];
      if (rec) Object.assign(rec, provenance);
    });
  }
  const newPid = spawnResult.data?.pid ?? null;
  const identity = await verifyRestartedIdentity(record.sessionId, newPid);
  const liveness = await confirmStillRunning(newPid, identity, record.sessionId, {
    ...ctx.restartSettleMs !== void 0 ? { settleMs: ctx.restartSettleMs } : {},
    ...ctx.procRoot ? { procRoot: ctx.procRoot } : {},
    command
  });
  if (!liveness.ok) {
    await markNotRunning(ctx, record.sessionId);
    await writeEvent({
      event: "peer_restart_died_after_spawn",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: record.sessionId, pid: newPid, reason: liveness.reason }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_died_after_spawn",
      `The relaunched peer did not survive: ${liveness.reason}`,
      { sessionId: record.sessionId, pid: newPid, reason: liveness.reason }
    );
  }
  if (identity.mismatch) {
    await markNotRunning(ctx, record.sessionId);
    await writeEvent({
      event: "peer_restart_identity_mismatch",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        expected: record.sessionId,
        actual: identity.actual,
        pid: newPid,
        hint: "The peer is running but under a different session id \u2014 the record now points at an identity that no longer exists. Adopt the new id or stop the peer; do not trust lifecycle calls on this record."
      }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_mismatch",
      `Peer restarted as '${identity.actual ?? "unknown"}', not '${record.sessionId}' \u2014 the record is now orphaned.`,
      { expected: record.sessionId, actual: identity.actual, pid: newPid }
    );
  }
  await writeEvent({
    event: "peer_restarted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: record.sessionId, reason: args.reason ?? null, force: args.force }
  });
  return okResult(req.id, req.tool, {
    sessionId: record.sessionId,
    stop: stopResult.data,
    spawn: spawnResult.data
  });
}

// src/hosts/process-inspector.ts
var import_node_fs2 = require("node:fs");
var import_promises9 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path9 = require("node:path");
var DEFAULT_MAX_DEPTH = 8;
var UUID_RE2 = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function parsePpidFromStat(stat4) {
  const close = stat4.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat4.slice(close + 1).trim().split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  return Number.isNaN(ppid) ? null : ppid;
}
function sessionIdFromCmdline(cmdline) {
  const idx = cmdline.indexOf("--resume");
  if (idx === -1) return null;
  const rest = cmdline.slice(idx + "--resume".length).trim();
  const token = rest.split(/\s+/)[0] ?? "";
  const match = UUID_RE2.exec((0, import_node_path9.basename)(token));
  return match ? match[0] : null;
}
var LinuxProcessInspector = class {
  procRoot;
  sessionsDir;
  constructor(opts = {}) {
    this.procRoot = opts.procRoot ?? "/proc";
    this.sessionsDir = opts.sessionsDir ?? (0, import_node_path9.join)((0, import_node_os3.homedir)(), ".claude", "sessions");
  }
  async listClaudePeers() {
    let entries;
    try {
      entries = await (0, import_promises9.readdir)(this.procRoot);
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (Number.isNaN(pid) || String(pid) !== entry) continue;
      const comm = await this.readProcFile(pid, "comm");
      if (comm?.trim() !== "claude") continue;
      const stat4 = await this.readProcFile(pid, "stat");
      const ppid = stat4 ? parsePpidFromStat(stat4) : null;
      const raw = await this.readProcFile(pid, "cmdline");
      const argv = (raw ?? "").split("\0").filter((a) => a.length > 0);
      const cmdline = argv.join(" ").trim();
      const cwd = await this.readProcCwd(pid);
      const resolvedCommand = await this.resolveViaProcessPath(pid, argv[0] ?? "");
      const environ = await this.readProcEnviron(pid);
      const { sessionId, source } = await this.resolveSessionId(pid, cmdline);
      out.push({
        pid,
        ppid: ppid ?? 0,
        sessionId,
        sessionIdSource: source,
        cmdline,
        argv,
        cwd,
        resolvedCommand,
        environ
      });
    }
    return out;
  }
  /** Every `KEY=value` pair in `/proc/<pid>/environ`, unfiltered. */
  async readProcEnviron(pid) {
    const raw = await this.readProcFile(pid, "environ");
    if (!raw) return {};
    const out = {};
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  /**
   * Turn a bare command into an absolute path, using the process's own `PATH`.
   *
   * Only the owning process knows where its binary came from — under nvm the
   * directory is not on any system path. An already-absolute command is
   * returned unchanged; anything unresolvable returns null so the caller keeps
   * what it was given instead of guessing.
   */
  async resolveViaProcessPath(pid, command) {
    if (command.length === 0) return null;
    if (command.startsWith("/")) return command;
    const environ = await this.readProcFile(pid, "environ");
    if (!environ) return null;
    const pathVar = environ.split("\0").find((e) => e.startsWith("PATH="))?.slice("PATH=".length);
    if (!pathVar) return null;
    for (const dir of pathVar.split(":")) {
      if (dir.length === 0) continue;
      const candidate = (0, import_node_path9.join)(dir, command);
      try {
        await (0, import_promises9.access)(candidate, import_node_fs2.constants.X_OK);
        return candidate;
      } catch {
      }
    }
    return null;
  }
  async readProcCwd(pid) {
    try {
      return await (0, import_promises9.readlink)((0, import_node_path9.join)(this.procRoot, String(pid), "cwd"));
    } catch {
      return null;
    }
  }
  async ancestorsOf(pid, maxDepth = DEFAULT_MAX_DEPTH) {
    const chain = [];
    let current = pid;
    for (let i = 0; i < maxDepth; i++) {
      const stat4 = await this.readProcFile(current, "stat");
      if (!stat4) break;
      const ppid = parsePpidFromStat(stat4);
      if (ppid === null || ppid <= 1) break;
      chain.push(ppid);
      current = ppid;
    }
    return chain;
  }
  /**
   * `~/.claude/sessions/<pid>.json` is authoritative — it is the same file the
   * MCP server reads to learn its own identity, so it exists for every peer
   * including ones started without `--resume`. The command line is only a
   * fallback for the window where that file is missing.
   */
  async resolveSessionId(pid, cmdline) {
    try {
      const raw = await (0, import_promises9.readFile)((0, import_node_path9.join)(this.sessionsDir, `${pid}.json`), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.sessionId) return { sessionId: parsed.sessionId, source: "sessions-json" };
    } catch {
    }
    const fromArgs = sessionIdFromCmdline(cmdline);
    if (fromArgs) return { sessionId: fromArgs, source: "resume-arg" };
    return { sessionId: null, source: "none" };
  }
  async readProcFile(pid, name) {
    try {
      return await (0, import_promises9.readFile)((0, import_node_path9.join)(this.procRoot, String(pid), name), "utf-8");
    } catch {
      return null;
    }
  }
};
function defaultProcessInspector() {
  return new LinuxProcessInspector();
}

// src/handlers/team-adopt.ts
var TeamAdoptArgsSchema = external_exports.object({
  team: external_exports.string().min(1),
  mode: external_exports.enum(["auto", "manual"]).default("auto"),
  /** manual mode: host session key -> Claude session id. */
  mapping: external_exports.record(external_exports.string().min(1)).optional(),
  /** Safe by default — see the note above. */
  /**
   * Adopt only peers whose host session matches. Without it, `auto` sweeps
   * every window on the host into one team — so adopting four families under
   * four team stamps was impossible (plt-designer, v0.10.6 pilot).
   * Accepts a plain session name (`hmh`) or a `/regex/`.
   */
  hostSession: external_exports.string().min(1).optional(),
  dryRun: external_exports.boolean().default(true)
}).strict();
async function claudeInside(ctx, panePid) {
  const inspector = ctx.processInspector ?? defaultProcessInspector();
  const peers = await inspector.listClaudePeers();
  for (const proc of peers) {
    if (proc.pid === panePid) return proc;
    const chain = [proc.ppid, ...await inspector.ancestorsOf(proc.pid)];
    if (chain.includes(panePid)) return proc;
  }
  return void 0;
}
async function registeredPeerName(sessionId) {
  if (!sessionId) return null;
  const found = await resolvePeer(sessionId);
  return found.outcome === "found" ? found.peer.displayName || found.peer.name : null;
}
function ensureCommandDirOnPath(env, command) {
  if (!command || !command.startsWith("/")) return env;
  const dir = command.slice(0, command.lastIndexOf("/"));
  if (dir.length === 0) return env;
  const current = env["PATH"] ?? "";
  if (current.split(":").includes(dir)) return env;
  return { ...env, PATH: current.length > 0 ? `${dir}:${current}` : dir };
}
function extractLaunchParams(argv) {
  const [command, ...rest] = argv;
  const spawnArgs = [];
  let model = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--resume") {
      i++;
      continue;
    }
    if (a === "--model") {
      model = rest[i + 1] ?? null;
      i++;
      continue;
    }
    if (a !== void 0) spawnArgs.push(a);
  }
  return { ...command ? { command } : {}, spawnArgs, model };
}
async function discoverCandidates(ctx, hostSessions) {
  const inspector = ctx.processInspector ?? defaultProcessInspector();
  const peers = await inspector.listClaudePeers();
  const ownerBySessionKey = /* @__PURE__ */ new Map();
  for (const proc of peers) {
    const chain = [proc.pid, proc.ppid, ...await inspector.ancestorsOf(proc.pid)];
    const owner = hostSessions.find((s) => s.pid !== null && chain.includes(s.pid));
    if (!owner) continue;
    const list = ownerBySessionKey.get(owner.sessionKey) ?? [];
    list.push(proc);
    ownerBySessionKey.set(owner.sessionKey, list);
  }
  const candidates = [];
  const ambiguous2 = [];
  const skips = [];
  for (const session of hostSessions) {
    const procs = ownerBySessionKey.get(session.sessionKey) ?? [];
    if (procs.length === 0) {
      skips.push({ sessionKey: session.sessionKey, reason: "no_claude_process" });
      continue;
    }
    if (procs.length > 1) {
      ambiguous2.push({
        sessionKey: session.sessionKey,
        candidates: procs.map((p) => ({ pid: p.pid, sessionId: p.sessionId }))
      });
      continue;
    }
    const proc = procs[0];
    if (!proc.sessionId) {
      skips.push({
        sessionKey: session.sessionKey,
        reason: "no_session_id",
        details: `pid ${proc.pid} \u2014 neither ~/.claude/sessions/<pid>.json nor --resume yielded a UUID`
      });
      continue;
    }
    const registered = await registeredPeerName(proc.sessionId);
    const launch = extractLaunchParams(proc.argv);
    if (proc.resolvedCommand) launch.command = proc.resolvedCommand;
    candidates.push({
      sessionKey: session.sessionKey,
      label: registered ?? session.label,
      ...session.homeSession ? { homeSession: session.homeSession } : {},
      sessionId: proc.sessionId,
      pid: proc.pid,
      sessionIdSource: proc.sessionIdSource,
      ...launch.command ? { command: launch.command } : {},
      spawnArgs: launch.spawnArgs,
      model: launch.model,
      // The peer's own environment. Its PATH is the one that can actually find
      // its `node` and its `claude`. `harvestEnv` (not `sanitizeEnv`) because
      // this is being STORED: the pane-scoped vars would outlive their pane.
      spawnEnv: ensureCommandDirOnPath(harvestEnv(proc.environ), launch.command),
      ...proc.cwd ? { cwd: proc.cwd } : {}
    });
  }
  return { candidates, ambiguous: ambiguous2, skips };
}
async function handleTeamAdopt(req, ctx) {
  const parsed = TeamAdoptArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  if (args.mode === "manual" && !args.mapping) {
    return errResult(req.id, req.tool, "mapping_required", "mode:'manual' requires `mapping`", {
      team: args.team
    });
  }
  let windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  const sessionFilter = args.hostSession;
  if (sessionFilter !== void 0) {
    const rx = sessionFilter.startsWith("/") && sessionFilter.lastIndexOf("/") > 0 ? new RegExp(sessionFilter.slice(1, sessionFilter.lastIndexOf("/"))) : null;
    windows = windows.filter((w) => rx ? rx.test(w.session) : w.session === sessionFilter);
  }
  const hostSessions = windows.length > 0 ? windows.map((w) => ({
    sessionKey: w.target,
    label: w.windowName || w.label,
    homeSession: w.session,
    pid: w.pid
  })) : (await ctx.hostDriver.listSessions()).filter((s) => sessionFilter === void 0 || s.sessionKey === sessionFilter).map((s) => ({
    sessionKey: s.sessionKey,
    label: s.sessionKey,
    pid: s.pid
  }));
  let candidates = [];
  let ambiguous2 = [];
  let skips = [];
  if (args.mode === "manual") {
    for (const [rawKey, sessionId] of Object.entries(args.mapping ?? {})) {
      const target = parseHostTarget(rawKey);
      const sessionKey = formatHostTarget(target);
      const byLabel = windows.find((w) => w.label === rawKey || w.windowName === rawKey);
      let host = hostSessions.find((s) => s.sessionKey === sessionKey) ?? (byLabel ? {
        sessionKey: byLabel.target,
        label: byLabel.windowName || byLabel.label,
        pid: byLabel.pid
      } : void 0);
      if (!host && target.kind === "session") {
        const inSession = windows.filter((w) => w.session === sessionKey);
        if (inSession.length > 1) {
          ambiguous2.push({
            sessionKey,
            candidates: inSession.map((w) => ({ pid: w.pid ?? -1, sessionId: null }))
          });
          continue;
        }
        const only = inSession[0];
        host = only ? { sessionKey: only.target, label: only.windowName || only.label, pid: only.pid } : hostSessions.find((s) => s.sessionKey === sessionKey);
      }
      if (!host) {
        skips.push({ sessionKey, reason: "not_on_host" });
        continue;
      }
      const owning = host.pid === null ? void 0 : await claudeInside(ctx, host.pid);
      const launch = extractLaunchParams(owning?.argv ?? []);
      if (owning?.resolvedCommand) launch.command = owning.resolvedCommand;
      candidates.push({
        sessionKey: host.sessionKey,
        label: host.label,
        sessionId,
        pid: owning?.pid ?? host.pid,
        sessionIdSource: "manual",
        ...launch.command ? { command: launch.command } : {},
        spawnArgs: launch.spawnArgs,
        model: launch.model,
        ...owning ? { spawnEnv: ensureCommandDirOnPath(harvestEnv(owning.environ), launch.command) } : {},
        ...owning?.cwd ? { cwd: owning.cwd } : {}
      });
    }
  } else {
    const found = await discoverCandidates(ctx, hostSessions);
    candidates = found.candidates;
    ambiguous2 = found.ambiguous;
    skips = found.skips;
  }
  const fresh = [];
  for (const c of candidates) {
    const existing = ctx.state.peers[c.sessionId];
    if (existing && existing.status !== "stopped") {
      skips.push({
        sessionKey: c.sessionKey,
        reason: "already_adopted",
        details: `sessionId ${c.sessionId} already in state as '${existing.status}'`
      });
      continue;
    }
    fresh.push(c);
  }
  for (const a of ambiguous2) {
    await writeEvent({
      event: "adoption_ambiguous",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { team: args.team, sessionKey: a.sessionKey, candidates: a.candidates }
    });
  }
  const plan = {
    team: args.team,
    mode: args.mode,
    hostSession: args.hostSession ?? null,
    hostWindowsSeen: hostSessions.length,
    planned: fresh.map((c) => ({
      sessionKey: c.sessionKey,
      label: c.label ?? c.sessionKey,
      sessionId: c.sessionId,
      pid: c.pid,
      sessionIdSource: c.sessionIdSource,
      // Shown in the plan so a dry run can prove the record will be
      // restartable BEFORE anything is written.
      command: c.command ?? null,
      spawnArgs: c.spawnArgs ?? [],
      cwd: c.cwd ?? null,
      model: c.model ?? null
    })),
    ambiguous: ambiguous2,
    skipped: skips
  };
  if (args.dryRun) {
    await writeEvent({
      event: "team_adopt_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan
    });
    return okResult(req.id, req.tool, { dryRun: true, ...plan });
  }
  const hostDriverName = ctx.hostDriver.name;
  const adopted = [];
  for (const c of fresh) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[c.sessionId] = {
        sessionId: c.sessionId,
        name: c.label ?? c.sessionKey,
        hostDriver: hostDriverName,
        tmuxTarget: c.sessionKey,
        pid: c.pid,
        status: "live",
        team: args.team,
        // Flags that the daemon did not start this process: `startedAt` is
        // when we adopted it, not when it actually booted.
        adopted: true,
        // Carried from /proc so an adopted peer is restartable. Without these
        // the record is a name with no way to relaunch what it names.
        ...c.command ? { command: c.command } : {},
        ...c.spawnArgs ? { spawnArgs: c.spawnArgs } : {},
        ...c.cwd ? { cwd: c.cwd } : {},
        ...c.homeSession ? { homeSession: c.homeSession } : {},
        ...c.spawnEnv ? { spawnEnv: c.spawnEnv } : {},
        model: c.model ?? null,
        accountProfile: null,
        startedAt: now,
        lastUpdatedAt: now
      };
    });
    await writeEvent({
      event: "peer_adopted",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        team: args.team,
        sessionId: c.sessionId,
        sessionKey: c.sessionKey,
        pid: c.pid,
        sessionIdSource: c.sessionIdSource,
        hostDriver: hostDriverName
      }
    });
    adopted.push(c.sessionId);
  }
  const summary = {
    dryRun: false,
    team: args.team,
    mode: args.mode,
    adopted,
    ambiguous: ambiguous2,
    skipped: skips
  };
  await writeEvent({
    event: "team_adopt_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary
  });
  return okResult(req.id, req.tool, summary);
}

// src/handlers/team-layout.ts
var import_promises10 = require("node:fs/promises");
var import_node_path11 = require("node:path");

// src/handlers/wake.ts
var import_node_crypto5 = require("node:crypto");
var import_node_path10 = require("node:path");
var DEFAULT_WAKE_DELAY_MS = 8e3;
var DEFAULT_WAKE_PROMPT = "[daemon] Wake \u2014 you were resumed from a stopped state. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever woke you.";
function inboxPendingDir4(peerId) {
  return (0, import_node_path10.join)(bridgeRoot(), "inbox", peerId, "pending");
}
function generateMsgId3() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto5.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function writeWakeMsg(opts, threadId) {
  const msgId = generateMsgId3();
  const dirty = opts.stoppedCleanly === false;
  const envelope = {
    id: msgId,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: opts.sessionId, name: opts.sessionId },
    kind: "peer-wake",
    threadId,
    content: {
      instruction: "You were resumed from a stopped state. Re-onboard from your anchor before doing anything else, then report to whoever woke you.",
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null,
      ...dirty ? {
        warning: "Your previous stop was FORCED \u2014 you did not complete the stop-ack cycle, so your anchor and memory may be incomplete or mid-write. Verify them before trusting them."
      } : {}
    }
  };
  await atomicWriteJson((0, import_node_path10.join)(inboxPendingDir4(opts.sessionId), `${msgId}.json`), envelope);
  return msgId;
}
async function wakePeer(req, ctx, opts) {
  const threadId = `wake:${opts.sessionId}:${Date.now().toString(36)}`;
  let wakeMsgId = null;
  try {
    wakeMsgId = await writeWakeMsg(opts, threadId);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_wake_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: opts.sessionId, stage: "inbox_write", err }
    });
    return { sessionId: opts.sessionId, wakeMsgId: null, injected: false, error: err };
  }
  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    await writeEvent({
      event: "peer_wake_not_injected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: opts.sessionId,
        wakeMsgId,
        hostDriver: ctx.hostDriver.name,
        note: "driver has no send-keys \u2014 peer stays silent until a turn is triggered by hand"
      }
    });
    return { sessionId: opts.sessionId, wakeMsgId, injected: false };
  }
  const delay = opts.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const prompt = opts.wakePrompt ?? DEFAULT_WAKE_PROMPT;
  await writeEvent({
    event: "peer_wake_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: opts.sessionId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      injectedKeys: prompt,
      delayMs: delay
    }
  });
  try {
    await sendKeys(opts.sessionKey, prompt);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_wake_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: opts.sessionId, sessionKey: opts.sessionKey, stage: "send_keys", err }
    });
    return { sessionId: opts.sessionId, wakeMsgId, injected: false, error: err };
  }
  await writeEvent({
    event: "peer_woken",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: opts.sessionId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null
    }
  });
  await publishLifecycleEvent({
    event: "peer_woken",
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    details: { reason: opts.reason, stoppedCleanly: opts.stoppedCleanly ?? null }
  });
  return { sessionId: opts.sessionId, wakeMsgId, injected: true };
}

// src/handlers/team-layout.ts
var PeerSpecSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  displayName: external_exports.string().min(1),
  cwd: external_exports.string().min(1),
  command: external_exports.string().min(1),
  args: external_exports.array(external_exports.string()).default([]),
  resume: external_exports.boolean().default(false),
  model: external_exports.string().nullable().optional(),
  accountProfile: external_exports.string().nullable().optional(),
  extraAllowEnv: external_exports.array(external_exports.string()).default([]),
  extraEnv: external_exports.record(external_exports.string()).default({})
});
var TeamFileSchema = external_exports.object({
  team: external_exports.string().min(1),
  peers: external_exports.array(PeerSpecSchema)
});
var TeamLayoutArgsSchema = external_exports.object({
  team: external_exports.string().min(1),
  apply: external_exports.boolean().default(true),
  prune: external_exports.boolean().default(false),
  /**
   * Explicit team spec — bypasses the on-disk file. Used by tests
   * and by future callers who want to preview a spec before writing
   * it to teams/.
   */
  inline: TeamFileSchema.optional(),
  /**
   * Wake peers that were resumed from `status:"stopped"` (v0.10.1).
   *
   * On by default: a resumed session is silent until something triggers a
   * turn, so skipping the wake gives you a team that is running but deaf.
   * Turn it off only when you intend to drive the peers by hand.
   */
  wake: external_exports.boolean().default(true),
  /** Override the post-spawn settle delay before key injection. */
  wakeDelayMs: external_exports.number().int().min(0).max(12e4).optional()
}).strict();
function teamFilePath(team) {
  return (0, import_node_path11.join)(teamsDir(), `${team}.json`);
}
async function loadTeamSpec(team) {
  try {
    const raw = await (0, import_promises10.readFile)(teamFilePath(team), "utf-8");
    const parsed = TeamFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return null;
    throw e;
  }
}
async function handleTeamLayout(req, ctx) {
  const parsed = TeamLayoutArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  let spec;
  try {
    spec = args.inline ?? await loadTeamSpec(args.team);
  } catch (e) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_read_failed",
      e instanceof Error ? e.message : String(e),
      { team: args.team }
    );
  }
  if (!spec) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_missing",
      `No team file at ${teamFilePath(args.team)}`,
      {
        team: args.team
      }
    );
  }
  const specIds = new Set(spec.peers.map((p) => p.sessionId));
  const stateIds = new Set(Object.keys(ctx.state.peers));
  const stoppedIds = new Set(
    Object.entries(ctx.state.peers).filter(([, rec]) => rec.status === "stopped").map(([id]) => id)
  );
  const runningIds = new Set([...stateIds].filter((id) => !stoppedIds.has(id)));
  const toSpawn = spec.peers.filter((p) => !stateIds.has(p.sessionId));
  const toResume = spec.peers.filter((p) => stoppedIds.has(p.sessionId));
  const runningExtras = [...runningIds].filter((id) => !specIds.has(id));
  const toStop = args.prune ? runningExtras : [];
  const toForget = args.prune ? [...stoppedIds].filter((id) => !specIds.has(id)) : [];
  const diff = {
    team: spec.team,
    plannedSpawn: toSpawn.map((p) => p.sessionId),
    plannedResume: toResume.map((p) => p.sessionId),
    plannedStop: toStop,
    plannedForget: toForget,
    keptExtras: args.prune ? [] : runningExtras
  };
  await writeEvent({
    event: "team_layout_reconciling",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { ...diff, apply: args.apply, prune: args.prune }
  });
  if (!args.apply) {
    return okResult(req.id, req.tool, { mode: "plan", diff });
  }
  const spawnOne = async (p, forceResume, label) => {
    const record = ctx.state.peers[p.sessionId];
    const spawnReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:${label}:${p.sessionId}`,
      ts: req.ts,
      tool: "peer_spawn",
      args: {
        sessionId: p.sessionId,
        displayName: p.displayName,
        cwd: p.cwd,
        command: p.command,
        args: p.args,
        // Resuming a tombstone MUST pass `--resume <sessionId>`, otherwise the
        // peer comes back as a blank session and its transcript is orphaned.
        resume: forceResume || p.resume,
        // Fall back to what the peer was last running with, so a stop→start
        // round trip does not silently downgrade the model.
        model: p.model ?? record?.model ?? null,
        accountProfile: p.accountProfile ?? record?.accountProfile ?? null,
        extraAllowEnv: p.extraAllowEnv,
        extraEnv: p.extraEnv
      },
      requestedBy: req.requestedBy
    };
    return handlePeerSpawn(spawnReq, ctx);
  };
  const stampTeam = async (sessionId) => {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[sessionId];
      if (rec) rec.team = spec.team;
    });
  };
  const spawnedOk = [];
  const spawnedFailed = [];
  for (const p of toSpawn) {
    const res = await spawnOne(p, false, "spawn");
    if (res.outcome === "ok") {
      await stampTeam(p.sessionId);
      spawnedOk.push(p.sessionId);
    } else {
      spawnedFailed.push({ sessionId: p.sessionId, err: res.error?.message ?? "unknown" });
    }
  }
  const resumedOk = [];
  const resumedFailed = [];
  const wakeOutcomes = [];
  for (const p of toResume) {
    const stoppedCleanly = ctx.state.peers[p.sessionId]?.stoppedCleanly ?? null;
    const res = await spawnOne(p, true, "resume");
    if (res.outcome !== "ok") {
      resumedFailed.push({ sessionId: p.sessionId, err: res.error?.message ?? "unknown" });
      continue;
    }
    await stampTeam(p.sessionId);
    resumedOk.push(p.sessionId);
    if (!args.wake) continue;
    const data = res.data;
    const outcome = await wakePeer(req, ctx, {
      sessionId: p.sessionId,
      sessionKey: data?.sessionKey ?? p.displayName,
      reason: `team_layout_resume:${spec.team}`,
      stoppedCleanly,
      ...args.wakeDelayMs !== void 0 ? { wakeDelayMs: args.wakeDelayMs } : {}
    });
    wakeOutcomes.push(outcome);
  }
  const stoppedOk = [];
  const stoppedFailed = [];
  const forgotten = [];
  if (args.prune) {
    for (const id of toStop) {
      const stopReq = {
        schemaVersion: req.schemaVersion,
        id: `${req.id}:stop:${id}`,
        ts: req.ts,
        tool: "peer_stop",
        args: { peer: id, reason: `team_layout_prune:${spec.team}` },
        requestedBy: req.requestedBy
      };
      const res = await handlePeerStop(stopReq, ctx);
      if (res.outcome === "ok") stoppedOk.push(id);
      else stoppedFailed.push({ sessionId: id, err: res.error?.message ?? "unknown" });
    }
    for (const id of toForget) {
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[id];
      });
      forgotten.push(id);
    }
    if (forgotten.length > 0) {
      await writeEvent({
        event: "team_layout_tombstones_forgotten",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { team: spec.team, forgotten }
      });
    }
  }
  const wokenOk = wakeOutcomes.filter((w) => w.injected).map((w) => w.sessionId);
  const wokenSilent = wakeOutcomes.filter((w) => !w.injected).map((w) => ({ sessionId: w.sessionId, err: w.error ?? "not injected" }));
  await writeEvent({
    event: "team_layout_applied",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      spawnedOk,
      spawnedFailed,
      resumedOk,
      resumedFailed,
      wokenOk,
      wokenSilent,
      stoppedOk,
      stoppedFailed,
      forgotten,
      keptExtras: diff.keptExtras
    }
  });
  const failed = spawnedFailed.length > 0 || resumedFailed.length > 0 || stoppedFailed.length > 0;
  const result = {
    team: spec.team,
    spawnedOk,
    spawnedFailed,
    resumedOk,
    resumedFailed,
    wokenOk,
    wokenSilent,
    stoppedOk,
    stoppedFailed,
    forgotten,
    keptExtras: diff.keptExtras
  };
  if (failed) {
    return errResult(
      req.id,
      req.tool,
      "team_layout_partial_failure",
      "Some peers could not be reconciled \u2014 see failed lists",
      result
    );
  }
  return okResult(req.id, req.tool, result);
}

// src/handlers/team-reconcile.ts
var import_node_fs3 = require("node:fs");
var import_node_path12 = require("node:path");
var TeamReconcileArgsSchema = external_exports.object({
  /** Restrict the report to one team. Unmanaged processes are still listed. */
  team: external_exports.string().min(1).optional(),
  /**
   * Set `status: "unknown"` on records whose process is gone. Nothing else is
   * written, and nothing is ever removed or signalled.
   */
  markDead: external_exports.boolean().default(false)
}).strict();
function pidAlive(pid, procRoot) {
  return (0, import_node_fs3.existsSync)((0, import_node_path12.join)(procRoot, String(pid)));
}
async function ownsProcess(inspector, panePid, childPid) {
  if (panePid === childPid) return true;
  try {
    return (await inspector.ancestorsOf(childPid)).includes(panePid);
  } catch {
    return true;
  }
}
async function handleTeamReconcile(req, ctx) {
  const parsed = TeamReconcileArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const procRoot = ctx.procRoot ?? "/proc";
  const inspector = ctx.processInspector ?? defaultProcessInspector();
  const livePeers = await inspector.listClaudePeers();
  const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  const sessions = await ctx.hostDriver.listSessions();
  const hostTargets = /* @__PURE__ */ new Map();
  for (const w of windows) hostTargets.set(w.target, w.pid);
  for (const s of sessions)
    if (!hostTargets.has(s.sessionKey)) hostTargets.set(s.sessionKey, s.pid);
  const records = Object.values(ctx.state.peers).filter(
    (r) => args.team === void 0 || r.team === args.team
  );
  const drift = [];
  const healthy = [];
  const accountedPids = /* @__PURE__ */ new Set();
  for (const rec of records) {
    if (rec.pid !== null) accountedPids.add(rec.pid);
    if (rec.status === "stopped") {
      healthy.push(rec.sessionId);
      continue;
    }
    const base = {
      sessionId: rec.sessionId,
      name: rec.name,
      team: rec.team ?? null,
      recordedPid: rec.pid,
      tmuxTarget: rec.tmuxTarget
    };
    const alive = rec.pid !== null && pidAlive(rec.pid, procRoot);
    if (!alive) {
      drift.push({
        ...base,
        kind: "dead",
        actualPid: null,
        detail: rec.pid === null ? `record is '${rec.status}' with no pid at all` : `record is '${rec.status}' but pid ${rec.pid} is not running`
      });
      continue;
    }
    if (rec.tmuxTarget !== null && hostTargets.size > 0 && !hostTargets.has(rec.tmuxTarget)) {
      drift.push({
        ...base,
        kind: "host_missing",
        actualPid: rec.pid,
        detail: `pid ${rec.pid} is alive but host target '${rec.tmuxTarget}' no longer exists`
      });
      continue;
    }
    const targetPid = rec.tmuxTarget !== null ? hostTargets.get(rec.tmuxTarget) ?? null : null;
    const targetOwnsRecord = targetPid !== null && rec.pid !== null && await ownsProcess(inspector, targetPid, rec.pid);
    if (targetPid !== null && rec.pid !== null && targetPid !== rec.pid && !targetOwnsRecord) {
      drift.push({
        ...base,
        kind: "pid_changed",
        actualPid: targetPid,
        detail: `host target '${rec.tmuxTarget}' holds pid ${targetPid}, record says ${rec.pid}`
      });
      continue;
    }
    healthy.push(rec.sessionId);
  }
  const knownSessionIds = new Set(Object.keys(ctx.state.peers));
  for (const proc of livePeers) {
    if (proc.sessionId && knownSessionIds.has(proc.sessionId)) continue;
    if (accountedPids.has(proc.pid)) continue;
    drift.push({
      kind: "unmanaged",
      sessionId: proc.sessionId,
      name: null,
      team: null,
      recordedPid: null,
      actualPid: proc.pid,
      tmuxTarget: null,
      detail: `pid ${proc.pid} is a Claude peer with no record${proc.sessionId ? "" : " and no resolvable session id"}`
    });
  }
  const marked = [];
  if (args.markDead) {
    const deadIds = drift.filter((d) => d.kind === "dead" && d.sessionId).map((d) => d.sessionId);
    if (deadIds.length > 0) {
      await applyStateChange(ctx.state, (draft) => {
        for (const id of deadIds) {
          const rec = draft.peers[id];
          if (rec) {
            rec.status = "unknown";
            rec.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
          }
        }
      });
      marked.push(...deadIds);
    }
  }
  const byKind = drift.reduce((acc, d) => {
    acc[d.kind] = (acc[d.kind] ?? 0) + 1;
    return acc;
  }, {});
  const report = {
    team: args.team ?? null,
    recordsChecked: records.length,
    hostTargetsSeen: hostTargets.size,
    livePeersSeen: livePeers.length,
    inSync: healthy.length,
    driftCount: drift.length,
    byKind,
    drift,
    marked,
    readOnly: !args.markDead
  };
  await writeEvent({
    event: "team_reconciled",
    // A clean report is `info`; drift is a warning, because a state file that
    // disagrees with the host is the precondition for every confident lie the
    // lifecycle tools can tell.
    level: drift.length > 0 ? "warn" : "info",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: report
  });
  return okResult(req.id, req.tool, report);
}

// src/handlers/team-release.ts
var TeamReleaseArgsSchema = external_exports.object({
  /** Release these peers by sessionId or name. Mutually exclusive with `team`. */
  peers: external_exports.array(external_exports.string().min(1)).optional(),
  /** Release every peer recorded under this team. Mutually exclusive with `peers`. */
  team: external_exports.string().min(1).optional(),
  reason: external_exports.string().optional(),
  dryRun: external_exports.boolean().default(true)
}).strict().refine((a) => a.peers === void 0 !== (a.team === void 0), {
  message: "pass exactly one of `peers` or `team`"
});
function describe(rec) {
  return {
    sessionId: rec.sessionId,
    name: rec.name,
    status: rec.status,
    team: rec.team ?? null,
    pid: rec.pid,
    tmuxTarget: rec.tmuxTarget,
    adopted: rec.adopted ?? false
  };
}
function callerTeamOf4(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}
async function handleTeamRelease(req, ctx) {
  const parsed = TeamReleaseArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const found = [];
  const notFound = [];
  const ambiguous2 = [];
  if (args.team !== void 0) {
    for (const rec of Object.values(ctx.state.peers)) {
      if (rec.team === args.team) found.push(rec);
    }
    if (ambiguous2.length > 0) {
      return errResult(
        req.id,
        req.tool,
        "ambiguous_peer",
        ambiguous2.map((a) => ambiguousPeerMessage(a.ref, a.candidates)).join(" | "),
        { ambiguous: ambiguous2 }
      );
    }
    if (found.length === 0) {
      return errResult(
        req.id,
        req.tool,
        "team_not_found",
        `No peers recorded under team '${args.team}'`,
        {
          team: args.team,
          knownTeams: [...new Set(Object.values(ctx.state.peers).map((p) => p.team ?? "(none)"))]
        }
      );
    }
  } else {
    for (const key of args.peers ?? []) {
      const resolved = resolvePeerRef(ctx.state.peers, key, callerTeamOf4(req, ctx));
      if (resolved.kind === "ambiguous") {
        ambiguous2.push({ ref: key, candidates: resolved.candidates });
        continue;
      }
      const rec = resolved.kind === "found" ? resolved.record : null;
      if (!rec) {
        notFound.push(key);
        continue;
      }
      if (!found.some((f) => f.sessionId === rec.sessionId)) found.push(rec);
    }
    if (found.length === 0) {
      return errResult(
        req.id,
        req.tool,
        "peer_not_found",
        `None of the requested peers are in daemon state: ${notFound.join(", ")}`,
        { notFound, known: Object.keys(ctx.state.peers) }
      );
    }
  }
  const plan = {
    dryRun: args.dryRun,
    reason: args.reason ?? null,
    releasing: found.map(describe),
    notFound,
    // Said explicitly, because the entire point of this tool is what it does
    // NOT do, and an operator reading a plan should not have to infer it.
    processesAffected: 0,
    note: "State-only. No process is signalled, no host session or window is touched."
  };
  if (args.dryRun) {
    await writeEvent({
      event: "team_release_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan
    });
    return okResult(req.id, req.tool, plan);
  }
  await applyStateChange(ctx.state, (draft) => {
    for (const rec of found) delete draft.peers[rec.sessionId];
  });
  for (const rec of found) {
    await writeEvent({
      event: "peer_released",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: rec.sessionId,
        name: rec.name,
        team: rec.team ?? null,
        pid: rec.pid,
        tmuxTarget: rec.tmuxTarget,
        adopted: rec.adopted ?? false,
        statusAtRelease: rec.status,
        reason: args.reason ?? null,
        // The audit trail has to record that the process outlived the record,
        // or a later reader will assume a release was a stop.
        processLeftRunning: true
      }
    });
  }
  return okResult(req.id, req.tool, {
    ...plan,
    dryRun: false,
    released: found.map((r) => r.sessionId)
  });
}

// src/handlers/team-restart.ts
var DEFAULT_SETTLE_MS = 3e3;
var TeamRestartArgsSchema = external_exports.object({
  peers: external_exports.array(external_exports.string().min(1)).optional(),
  team: external_exports.string().min(1).optional(),
  reason: external_exports.string().optional(),
  /**
   * Milliseconds to wait after each peer before starting the next. Gives the
   * relaunched process time to come up so a rolling restart does not become a
   * simultaneous one.
   */
  settleMs: external_exports.number().int().min(0).max(12e4).default(DEFAULT_SETTLE_MS),
  /** Keep going after a peer fails to restart. Off, deliberately. */
  continueOnError: external_exports.boolean().default(false),
  dryRun: external_exports.boolean().default(true)
}).strict().refine((a) => a.peers === void 0 !== (a.team === void 0), {
  message: "pass exactly one of `peers` or `team`"
});
function orderPeers(records) {
  const isVelitel = (r) => (r.name ?? "").includes("velitel");
  return [...records.filter((r) => !isVelitel(r)), ...records.filter(isVelitel)];
}
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
function callerTeamOf5(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.team ?? null;
}
async function handleTeamRestart(req, ctx) {
  const parsed = TeamRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  let selected;
  const notFound = [];
  const ambiguous2 = [];
  if (args.team !== void 0) {
    selected = Object.values(ctx.state.peers).filter((r) => r.team === args.team);
    if (selected.length === 0) {
      return errResult(req.id, req.tool, "team_not_found", `No peers under team '${args.team}'`, {
        team: args.team
      });
    }
  } else {
    selected = [];
    for (const key of args.peers ?? []) {
      const resolved = resolvePeerRef(ctx.state.peers, key, callerTeamOf5(req, ctx));
      if (resolved.kind === "ambiguous") {
        ambiguous2.push({ ref: key, candidates: resolved.candidates });
        continue;
      }
      const rec = resolved.kind === "found" ? resolved.record : null;
      if (!rec) {
        notFound.push(key);
        continue;
      }
      if (!selected.some((s) => s.sessionId === rec.sessionId)) selected.push(rec);
    }
    if (ambiguous2.length > 0) {
      return errResult(
        req.id,
        req.tool,
        "ambiguous_peer",
        ambiguous2.map((a) => ambiguousPeerMessage(a.ref, a.candidates)).join(" | "),
        { ambiguous: ambiguous2 }
      );
    }
    if (notFound.length > 0) {
      return errResult(
        req.id,
        req.tool,
        "peer_not_found",
        `Not in daemon state: ${notFound.join(", ")} \u2014 nothing was restarted`,
        { notFound, known: Object.keys(ctx.state.peers) }
      );
    }
  }
  const ordered = orderPeers(selected);
  const unrestartable = ordered.filter((r) => !r.command);
  if (unrestartable.length > 0) {
    await writeEvent({
      event: "team_restart_refused",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { missingLaunchParams: unrestartable.map((r) => r.sessionId) }
    });
    return errResult(
      req.id,
      req.tool,
      "launch_params_missing",
      `${unrestartable.length} of ${ordered.length} peers have no recorded command and would relaunch as a bare 'claude'. Nothing was restarted.`,
      {
        peers: unrestartable.map((r) => ({ sessionId: r.sessionId, name: r.name })),
        hint: "Records written before v0.10.3 lack launch parameters. Re-spawn those peers, or adopt them again with a daemon that reads /proc."
      }
    );
  }
  const plan = {
    dryRun: args.dryRun,
    reason: args.reason ?? null,
    settleMs: args.settleMs,
    continueOnError: args.continueOnError,
    order: ordered.map((r) => ({
      sessionId: r.sessionId,
      name: r.name,
      tmuxTarget: r.tmuxTarget,
      pid: r.pid,
      command: r.command ?? null,
      cwd: r.cwd ?? null
    }))
  };
  if (args.dryRun) {
    await writeEvent({
      event: "team_restart_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: plan
    });
    return okResult(req.id, req.tool, plan);
  }
  const results = [];
  let stoppedEarly = false;
  for (const [i, rec] of ordered.entries()) {
    if (stoppedEarly) {
      results.push({
        sessionId: rec.sessionId,
        name: rec.name,
        outcome: "skipped",
        pidBefore: rec.pid,
        pidAfter: null
      });
      continue;
    }
    const pidBefore = rec.pid;
    const sub = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:restart:${i}`,
      ts: req.ts,
      tool: "peer_restart",
      args: { peer: rec.sessionId, reason: args.reason ?? "team_restart" },
      requestedBy: req.requestedBy
    };
    const res = await handlePeerRestart(sub, ctx);
    if (res.outcome === "error") {
      results.push({
        sessionId: rec.sessionId,
        name: rec.name,
        outcome: "failed",
        pidBefore,
        pidAfter: null,
        error: res.error?.message ?? "peer_restart failed"
      });
      if (!args.continueOnError) stoppedEarly = true;
      continue;
    }
    results.push({
      sessionId: rec.sessionId,
      name: rec.name,
      outcome: "restarted",
      pidBefore,
      pidAfter: ctx.state.peers[rec.sessionId]?.pid ?? null
    });
    if (args.settleMs > 0 && i < ordered.length - 1) await sleep2(args.settleMs);
  }
  const restarted = results.filter((r) => r.outcome === "restarted");
  const failed = results.filter((r) => r.outcome === "failed");
  const skipped = results.filter((r) => r.outcome === "skipped");
  await writeEvent({
    event: "team_restarted",
    level: failed.length > 0 ? "error" : "info",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: args.team ?? null,
      total: ordered.length,
      restarted: restarted.length,
      failed: failed.length,
      skipped: skipped.length,
      stoppedEarly,
      results
    }
  });
  const summary = {
    dryRun: false,
    total: ordered.length,
    restarted: restarted.map((r) => r.sessionId),
    failed: failed.map((r) => ({ sessionId: r.sessionId, error: r.error })),
    // Named, not merely absent from the success list: an operator has to know
    // which peers were never touched so they can finish the roll-out.
    skipped: skipped.map((r) => r.sessionId),
    stoppedEarly,
    results
  };
  if (failed.length > 0) {
    return errResult(
      req.id,
      req.tool,
      "team_restart_incomplete",
      `${failed.length} peer(s) failed to restart${stoppedEarly ? `, ${skipped.length} never attempted` : ""} \u2014 see results`,
      summary
    );
  }
  return okResult(req.id, req.tool, summary);
}

// src/handlers/team-status.ts
var TeamStatusArgsSchema = external_exports.object({
  team: external_exports.string().optional(),
  verbose: external_exports.boolean().default(false)
}).strict();
async function handleTeamStatus(req, ctx) {
  const parsed = TeamStatusArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  let hostSessions;
  try {
    hostSessions = await ctx.hostDriver.listSessions();
  } catch (e) {
    hostSessions = [];
  }
  let hostWindows = [];
  try {
    hostWindows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
  } catch {
    hostWindows = [];
  }
  const hostByKey = new Map(
    hostSessions.map((s) => [s.sessionKey, { sessionKey: s.sessionKey, pid: s.pid }])
  );
  for (const w of hostWindows) {
    if (!hostByKey.has(w.target)) hostByKey.set(w.target, { sessionKey: w.target, pid: w.pid });
  }
  const peers = Object.values(ctx.state.peers).map((record) => {
    const key = record.tmuxTarget ?? record.name;
    const host = hostByKey.get(key);
    return {
      sessionId: record.sessionId,
      name: record.name,
      hostDriver: record.hostDriver,
      tmuxTarget: record.tmuxTarget,
      status: record.status,
      model: record.model,
      accountProfile: record.accountProfile,
      pid: record.pid,
      startedAt: record.startedAt,
      lastUpdatedAt: record.lastUpdatedAt,
      hostAlive: host !== void 0,
      hostPid: host?.pid ?? null
    };
  });
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    hostDriver: ctx.hostDriver.name,
    team: args.team ?? null,
    peerCount: peers.length,
    peers: args.verbose ? peers : peers.map(({ sessionId, name, status, hostAlive }) => ({
      sessionId,
      name,
      status,
      hostAlive
    }))
  });
}

// src/handlers/team-stop.ts
var import_node_crypto6 = require("node:crypto");
var import_promises11 = require("node:fs/promises");
var import_node_path13 = require("node:path");
var DEFAULT_ANCHOR_TIMEOUT_MS2 = 12e4;
var DEFAULT_ACK_POLL_MS2 = 500;
var STOP_ACK_FILENAME_EXTENSION = ".json";
var PeerOrderableSchema = external_exports.object({
  sessionId: external_exports.string().min(1),
  displayName: external_exports.string().min(1),
  role: external_exports.string().optional()
});
var TeamStopFileSchema = external_exports.object({
  team: external_exports.string().min(1),
  peers: external_exports.array(PeerOrderableSchema).min(1)
});
var TeamStopArgsSchema = external_exports.object({
  team: external_exports.string().min(1),
  force: external_exports.boolean().default(false),
  anchorTimeoutMs: external_exports.number().int().positive().max(6e5).optional(),
  ackPollMs: external_exports.number().int().positive().max(1e4).optional(),
  dryRun: external_exports.boolean().default(false),
  inline: TeamStopFileSchema.optional()
}).strict();
function teamFilePath2(team) {
  return (0, import_node_path13.join)(teamsDir(), `${team}.json`);
}
async function loadTeamOrder(team) {
  try {
    const raw = await (0, import_promises11.readFile)(teamFilePath2(team), "utf-8");
    const json = JSON.parse(raw);
    const parsed = TeamStopFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Team spec parse failed: ${parsed.error.message}`);
    return parsed.data;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return null;
    throw e;
  }
}
function stopAckDir() {
  return (0, import_node_path13.join)(controlDir(), "stop-ack");
}
function stopAckPath(sessionId) {
  return (0, import_node_path13.join)(stopAckDir(), `${sessionId}${STOP_ACK_FILENAME_EXTENSION}`);
}
function inboxPendingDir5(peerId) {
  return (0, import_node_path13.join)(bridgeRoot(), "inbox", peerId, "pending");
}
function generateMsgId4() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto6.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function fileExists2(path) {
  try {
    await (0, import_promises11.access)(path);
    return true;
  } catch {
    return false;
  }
}
async function pollForAck2(sessionId, deadline, pollMs) {
  const path = stopAckPath(sessionId);
  while (Date.now() < deadline) {
    if (await fileExists2(path)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return fileExists2(path);
}
async function consumeAckFile2(sessionId) {
  const src = stopAckPath(sessionId);
  const done = (0, import_node_path13.join)(stopAckDir(), "done");
  try {
    await (0, import_promises11.mkdir)(done, { recursive: true });
    await (0, import_promises11.rename)(src, (0, import_node_path13.join)(done, `${sessionId}-${Date.now()}.json`));
  } catch {
    await (0, import_promises11.unlink)(src).catch(() => void 0);
  }
}
async function writeStopRequestMsg(peerId, threadId, reason) {
  const msgId = generateMsgId4();
  const envelope = {
    id: msgId,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    from: { sessionId: "control-plane-daemon", name: "control-plane-daemon" },
    to: { sessionId: peerId, name: peerId },
    kind: "stop-request",
    threadId,
    content: {
      instruction: "Finish or park current work, flush anchor + memory, then touch ~/.claude-bridge/control/stop-ack/<sessionId>.json \u2014 the daemon will kill your session once the ack file is present.",
      reason
    }
  };
  const path = (0, import_node_path13.join)(inboxPendingDir5(peerId), `${msgId}.json`);
  await atomicWriteJson(path, envelope);
  return msgId;
}
async function stopSinglePeer(req, ctx, peer, args, threadId, anchorTimeoutMs, ackPollMs) {
  const record = ctx.state.peers[peer.sessionId];
  if (!record) {
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  const sessionKey = record.tmuxTarget ?? record.name;
  const alive = record.tmuxTarget ? await ctx.hostDriver.hasSession(sessionKey) : false;
  if (!alive) {
    const stopReq2 = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:stop:${peer.sessionId}`,
      ts: req.ts,
      tool: "peer_stop",
      args: {
        peer: peer.sessionId,
        reason: `team_stop:${args.team}:dead`,
        force: false,
        keepInState: true,
        stoppedCleanly: null
      },
      requestedBy: req.requestedBy
    };
    const res2 = await handlePeerStop(stopReq2, ctx);
    if (res2.outcome === "error") {
      return {
        sessionId: peer.sessionId,
        displayName: peer.displayName,
        outcome: "failed",
        err: res2.error?.message
      };
    }
    await writeEvent({
      event: "peer_stopped_dead",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId }
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "dead" };
  }
  await (0, import_promises11.mkdir)(stopAckDir(), { recursive: true });
  let stopReqMsgId;
  try {
    stopReqMsgId = await writeStopRequestMsg(
      peer.sessionId,
      threadId,
      args.force ? "force:true" : null
    );
  } catch (e) {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: e instanceof Error ? e.message : String(e)
    };
  }
  await writeEvent({
    event: "peer_stop_requested",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      sessionId: peer.sessionId,
      sessionKey,
      team: args.team,
      threadId,
      stopReqMsgId,
      timeoutMs: anchorTimeoutMs
    }
  });
  const deadline = Date.now() + anchorTimeoutMs;
  const acked = await pollForAck2(peer.sessionId, deadline, ackPollMs);
  if (!acked && !args.force) {
    await writeEvent({
      event: "stop_ack_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        sessionId: peer.sessionId,
        sessionKey,
        team: args.team,
        threadId,
        timeoutMs: anchorTimeoutMs
      }
    });
    return { sessionId: peer.sessionId, displayName: peer.displayName, outcome: "skipped" };
  }
  if (acked) {
    await consumeAckFile2(peer.sessionId);
  }
  const stopReq = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop:${peer.sessionId}`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: peer.sessionId,
      reason: `team_stop:${args.team}:${acked ? "cleanly" : "forced"}`,
      force: !acked,
      keepInState: true,
      stoppedCleanly: acked
    },
    requestedBy: req.requestedBy
  };
  const res = await handlePeerStop(stopReq, ctx);
  if (res.outcome === "error") {
    return {
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      outcome: "failed",
      err: res.error?.message
    };
  }
  await writeEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { sessionId: peer.sessionId, sessionKey, team: args.team, threadId }
  });
  await publishLifecycleEvent({
    event: acked ? "peer_stopped_cleanly" : "peer_stopped_forced",
    sessionId: peer.sessionId,
    sessionKey,
    details: { team: args.team, threadId }
  });
  return {
    sessionId: peer.sessionId,
    displayName: peer.displayName,
    outcome: acked ? "cleanly" : "forced"
  };
}
function orderPeersForStop(peers) {
  const veliteli = peers.filter((p) => p.role === "velitel");
  const rest = peers.filter((p) => p.role !== "velitel");
  return veliteli.length > 0 ? [...rest, ...veliteli] : peers.slice();
}
async function handleTeamStop(req, ctx) {
  const parsed = TeamStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  let spec;
  try {
    spec = args.inline ?? await loadTeamOrder(args.team);
  } catch (e) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_read_failed",
      e instanceof Error ? e.message : String(e),
      { team: args.team }
    );
  }
  if (!spec) {
    return errResult(
      req.id,
      req.tool,
      "team_spec_missing",
      `No team file at ${teamFilePath2(args.team)}`,
      { team: args.team }
    );
  }
  const ordered = orderPeersForStop(spec.peers);
  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS2;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS2;
  const threadId = `team-stop:${spec.team}:${Date.now().toString(36)}`;
  if (args.dryRun) {
    return okResult(req.id, req.tool, {
      mode: "dryRun",
      team: spec.team,
      order: ordered.map((p) => ({
        sessionId: p.sessionId,
        displayName: p.displayName,
        role: p.role ?? null
      })),
      anchorTimeoutMs,
      force: args.force
    });
  }
  await writeEvent({
    event: "team_stop_started",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      team: spec.team,
      threadId,
      order: ordered.map((p) => p.sessionId),
      anchorTimeoutMs,
      force: args.force
    }
  });
  const outcomes = [];
  for (const peer of ordered) {
    const outcome = await stopSinglePeer(
      req,
      ctx,
      peer,
      args,
      threadId,
      anchorTimeoutMs,
      ackPollMs
    );
    outcomes.push(outcome);
  }
  const summary = {
    team: spec.team,
    threadId,
    stoppedCleanly: outcomes.filter((o) => o.outcome === "cleanly").map((o) => o.sessionId),
    stoppedForced: outcomes.filter((o) => o.outcome === "forced").map((o) => o.sessionId),
    stoppedDead: outcomes.filter((o) => o.outcome === "dead").map((o) => o.sessionId),
    skipped: outcomes.filter((o) => o.outcome === "skipped").map((o) => o.sessionId),
    failedKill: outcomes.filter((o) => o.outcome === "failed").map((o) => ({ sessionId: o.sessionId, err: o.err ?? "unknown" }))
  };
  await writeEvent({
    event: "team_stop_completed",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: summary
  });
  return okResult(req.id, req.tool, summary);
}

// src/handlers/index.ts
var HANDLERS = {
  peer_spawn: handlePeerSpawn,
  peer_stop: handlePeerStop,
  peer_restart: handlePeerRestart,
  peer_compact: handlePeerCompact,
  team_status: handleTeamStatus,
  team_layout: handleTeamLayout,
  team_stop: handleTeamStop,
  team_adopt: handleTeamAdopt,
  team_release: handleTeamRelease,
  team_reconcile: handleTeamReconcile,
  team_restart: handleTeamRestart,
  control_status: handleControlStatus
};
async function dispatch(req, ctx) {
  const handler = HANDLERS[req.tool];
  if (!handler) {
    await writeEvent({
      event: "request_unknown_tool",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { tool: req.tool }
    });
    return errResult(req.id, req.tool, "unknown_tool", `No handler for tool '${req.tool}'`, {
      supported: Object.keys(HANDLERS)
    });
  }
  return handler(req, ctx);
}

// src/heartbeat.ts
var import_promises12 = require("node:fs/promises");
var log5 = makeLogger("daemon.heartbeat");
var timer = null;
async function touch() {
  const now = /* @__PURE__ */ new Date();
  try {
    await (0, import_promises12.utimes)(heartbeatPath(), now, now);
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") {
      await (0, import_promises12.writeFile)(heartbeatPath(), "");
    } else {
      log5.warn("heartbeat_touch_failed", { err: String(e) });
    }
  }
}
async function startHeartbeat(intervalMs = 5e3) {
  await touch();
  timer = setInterval(() => {
    void touch();
  }, intervalMs);
  timer.unref();
}
function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// src/hosts/tmux-driver.ts
var import_node_child_process = require("node:child_process");
var import_node_fs4 = require("node:fs");
var import_promises13 = require("node:fs/promises");
var import_node_path14 = require("node:path");
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var log6 = makeLogger("daemon.host.tmux");
var EXEC_DEFAULTS = { killSignal: "SIGKILL" };
var TMUX_OWNED_VARS = ["TMUX", "TMUX_PANE"];
var PANE_SELF_DESCRIBING = [
  // Empty only if tmux failed to set it; the built-in default beats nothing.
  'TERM="${TERM:-screen-256color}"',
  'TMUX="$TMUX"',
  'TMUX_PANE="$TMUX_PANE"'
];
function shQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function paneCommand(env, command, args) {
  const envBin = (0, import_node_fs4.existsSync)("/usr/bin/env") ? "/usr/bin/env" : "env";
  const assignments = Object.entries(env).filter(([k]) => !TMUX_OWNED_VARS.includes(k) && k !== "TERM").map(([k, v]) => `${k}=${shQuote(v)}`);
  const script = [
    "exec",
    envBin,
    "-i",
    ...assignments,
    ...PANE_SELF_DESCRIBING,
    shQuote(command),
    ...args.map(shQuote)
  ].join(" ");
  return ["/bin/sh", "-c", script];
}
var QUERY_TIMEOUT_MS = 5e3;
var MUTATE_TIMEOUT_MS = 1e4;
var SEND_KEYS_TIMEOUT_MS = 5e3;
var DEFAULT_SEND_VERIFY_DELAY_MS = 250;
function paneContains(captured, keys) {
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const needle = flat(keys);
  if (needle.length === 0) return true;
  const haystack = flat(captured);
  const probe = needle.length > 40 ? needle.slice(-40) : needle;
  return haystack.includes(probe);
}
var TmuxDriver = class {
  name = "tmux";
  tmuxBin;
  verifyTimeoutMs;
  verifyIntervalMs;
  sendVerifyDelayMs;
  constructor(opts = {}) {
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 2e3;
    this.verifyIntervalMs = opts.verifyIntervalMs ?? 200;
    this.sendVerifyDelayMs = opts.sendVerifyDelayMs ?? DEFAULT_SEND_VERIFY_DELAY_MS;
  }
  async hasSession(sessionKey) {
    const t = parseHostTarget(sessionKey);
    if (t.kind === "window") {
      const windows = await this.listWindows();
      return windows.some((w) => w.target === t.windowId);
    }
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", t.session], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS
      });
      return true;
    } catch {
      return false;
    }
  }
  /** Session-only probe. `hasSession` resolves window ids; this asks about a session. */
  async rawHasSession(session) {
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", `${session}:`], {
        ...EXEC_DEFAULTS,
        timeout: QUERY_TIMEOUT_MS
      });
      return true;
    } catch {
      return false;
    }
  }
  async listWindows() {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        [
          "list-panes",
          "-a",
          "-F",
          "#{window_id}	#{session_name}	#{window_index}	#{window_name}	#{pane_pid}"
        ],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [windowId, session, idxStr, windowName, pidStr] = trimmed.split("	");
        if (!windowId || !session || idxStr === void 0) continue;
        const window = Number.parseInt(idxStr, 10);
        if (Number.isNaN(window)) continue;
        const target = windowId;
        if (seen.has(target)) continue;
        seen.add(target);
        const pid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        out.push({
          target,
          label: `${session}:${window}`,
          session,
          window,
          windowName: windowName ?? "",
          pid: Number.isNaN(pid) ? null : pid
        });
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no server running")) return [];
      throw e;
    }
  }
  /**
   * Sessions that also hold this window, other than its own.
   *
   * tmux can link one window into several sessions. `kill-window` removes it
   * from all of them at once, so a linked window must be UNLINKED from the
   * caller's session instead — killing it would take a peer out of somebody
   * else's session too. v0.10.1 measured that `kill-session` has no such
   * hazard and dropped the guard; `kill-window` is now reachable, so it is back.
   */
  async linkedElsewhere(target) {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", target, "#{window_linked_sessions_list}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const { stdout: ownOut } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", target, "#{session_name}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const own = ownOut.trim();
      return stdout.trim().split(/[\s,]+/).filter((n) => n.length > 0 && n !== own);
    } catch {
      return [];
    }
  }
  async spawn(opts) {
    const asWindow = opts.inSession !== void 0;
    const parentSession = opts.inSession ? sanitizeSessionKey(opts.inSession) : null;
    const canonicalKey = asWindow ? opts.sessionKey : sanitizeSessionKey(opts.sessionKey);
    const args = asWindow ? [
      "new-window",
      "-d",
      ...opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : [],
      "-P",
      // Print the new window's id so the caller can address it. A window
      // index would be wrong: `renumber-windows` shifts those on every kill.
      "-F",
      "#{window_id}",
      "-t",
      `${parentSession}:`,
      "-c",
      opts.cwd,
      "--",
      ...paneCommand(opts.env, opts.command, opts.args)
    ] : [
      "new-session",
      "-d",
      ...opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : [],
      "-s",
      canonicalKey,
      "-c",
      opts.cwd,
      "--",
      ...paneCommand(opts.env, opts.command, opts.args)
    ];
    let effectiveArgs = args;
    let recreatedHome = false;
    if (asWindow && parentSession !== null && !await this.rawHasSession(parentSession)) {
      log6.info("tmux_home_session_recreated", { session: parentSession });
      effectiveArgs = [
        "new-session",
        "-d",
        ...opts.windowName ? ["-n", sanitizeSessionKey(opts.windowName)] : [],
        // Print the window id here too: the record's address must stay a window
        // id whether the session was already there or had to be remade.
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        parentSession,
        "-c",
        opts.cwd,
        "--",
        ...paneCommand(opts.env, opts.command, opts.args)
      ];
      recreatedHome = true;
    }
    const { env } = opts;
    let createdWindowId = null;
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, effectiveArgs, {
        ...EXEC_DEFAULTS,
        // Kept for the tmux CLIENT process itself. It does NOT reach the pane —
        // see envPrefix() for why the pane's environment is built on the
        // command line instead.
        env,
        timeout: MUTATE_TIMEOUT_MS
      });
      if (asWindow) createdWindowId = stdout.trim() || null;
    } catch (e) {
      log6.error("tmux_spawn_failed", {
        sessionKey: opts.sessionKey,
        canonicalKey,
        err: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }
    if (canonicalKey !== opts.sessionKey) {
      log6.info("session_key_canonicalized", {
        raw: opts.sessionKey,
        canonical: canonicalKey
      });
    }
    const effectiveKey = createdWindowId ?? canonicalKey;
    const pid = await this.readSessionPid(effectiveKey);
    if (pid === null) {
      log6.error("tmux_spawn_no_pane_pid", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        hint: "new-session returned 0 but no pane pid \u2014 the command most likely exited immediately"
      });
    }
    return { sessionKey: effectiveKey, alive: pid !== null, pid };
  }
  async kill(sessionKey, opts = {}) {
    const t = parseHostTarget(sessionKey);
    const canonical = t.kind === "window" ? t.windowId : t.session;
    if (!await this.hasSession(canonical)) return;
    const verb = t.kind === "window" ? "kill-window" : "kill-session";
    if (t.kind === "window") {
      const linked = await this.linkedElsewhere(t.windowId);
      if (linked.length > 0) {
        log6.warn("tmux_window_linked_unlinking", { target: t.windowId, linkedSessions: linked });
        await execFileAsync(this.tmuxBin, ["unlink-window", "-t", t.windowId], {
          ...EXEC_DEFAULTS,
          timeout: MUTATE_TIMEOUT_MS
        });
        return;
      }
    }
    try {
      await execFileAsync(this.tmuxBin, [verb, "-t", canonical], {
        ...EXEC_DEFAULTS,
        timeout: MUTATE_TIMEOUT_MS
      });
    } catch (e) {
      if (!await this.hasSession(canonical)) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("can't find session") || msg.includes("can't find window")) return;
      throw e;
    }
    const budget = opts.force === true ? this.verifyTimeoutMs / 2 : this.verifyTimeoutMs;
    const respawned = !await this.verifyKilled(canonical, budget);
    if (respawned) {
      log6.error("tmux_kill_respawn_detected", { sessionKey: canonical });
      throw new Error(
        `Session '${canonical}' respawned within ${budget}ms after kill \u2014 investigate supervisor (bg-pty-host?)`
      );
    }
  }
  async listSessions() {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["list-sessions", "-F", "#{session_name}	#{pane_pid}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const records = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, pidStr] = trimmed.split("	");
        if (!name) continue;
        const parsedPid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        records.push({
          sessionKey: name,
          alive: true,
          pid: Number.isNaN(parsedPid) ? null : parsedPid
        });
      }
      return records;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no server running")) return [];
      throw e;
    }
  }
  /**
   * Inject keys into a pane and PROVE they landed (v0.10.1).
   *
   * Evidence for why this is not optional: during the 2026-08-02 tmux
   * consolidation a `/exit` was sent to a peer and simply never arrived — no
   * trace in the transcript, the input box empty, the process untouched — and
   * the script that sent it then hung for 13 minutes with no log line. Two
   * lessons, both encoded here: a send without verification is undelivered
   * mail, and a wait without a log is an undiagnosable incident.
   *
   * Sequence:
   *   1. If the pane is in copy-mode it swallows input — cancel out of it first.
   *   2. Send the TEXT alone and confirm it is visible in the pane. This is the
   *      real check: it proves the keystrokes reached the application while the
   *      line is still uncommitted, so a failure costs nothing.
   *   3. Only then send Enter.
   *
   * Every attempt is appended to `control/logs/sendkeys-<sessionKey>.log`.
   * Throws when the text cannot be confirmed, so callers surface a hard failure
   * instead of assuming delivery.
   */
  async sendKeys(sessionKey, keys) {
    const canonical = formatHostTarget(parseHostTarget(sessionKey));
    const inMode = await this.paneInMode(canonical);
    if (inMode) {
      await this.tmux(["send-keys", "-t", canonical, "-X", "cancel"], SEND_KEYS_TIMEOUT_MS).catch(
        () => void 0
      );
    }
    let delivered = false;
    let attempts = 0;
    let capturedTail = "";
    let lastError = null;
    for (attempts = 1; attempts <= 2 && !delivered; attempts++) {
      try {
        await this.tmux(["send-keys", "-t", canonical, keys], SEND_KEYS_TIMEOUT_MS);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      capturedTail = await this.capturePane(canonical);
      delivered = paneContains(capturedTail, keys);
    }
    await this.logSendKeys(canonical, {
      keys,
      paneInMode: inMode,
      attempts: attempts - 1,
      verdict: delivered ? "delivered" : "not-visible",
      ...lastError ? { error: lastError } : {},
      capturedTail: capturedTail.slice(-240)
    });
    if (!delivered) {
      log6.error("tmux_send_keys_unverified", {
        sessionKey: canonical,
        attempts: attempts - 1,
        err: lastError
      });
      throw new Error(
        `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts \u2014 text never appeared in the pane${lastError ? ` (tmux: ${lastError.split("\n")[0]})` : ""}`
      );
    }
    await this.tmux(["send-keys", "-t", canonical, "Enter"], SEND_KEYS_TIMEOUT_MS);
  }
  /** `#{pane_in_mode}` is "1" while the pane is in copy-mode / view-mode. */
  async paneInMode(sessionKey) {
    try {
      const { stdout } = await this.tmux(
        ["display-message", "-p", "-t", sessionKey, "#{pane_in_mode}"],
        QUERY_TIMEOUT_MS
      );
      return stdout.trim() === "1";
    } catch {
      return false;
    }
  }
  async capturePane(sessionKey) {
    try {
      const { stdout } = await this.tmux(
        ["capture-pane", "-p", "-t", sessionKey],
        QUERY_TIMEOUT_MS
      );
      return stdout;
    } catch {
      return "";
    }
  }
  async logSendKeys(sessionKey, entry) {
    try {
      const dir = (0, import_node_path14.join)(controlDir(), "logs");
      await (0, import_promises13.mkdir)(dir, { recursive: true });
      const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), sessionKey, ...entry });
      await (0, import_promises13.appendFile)((0, import_node_path14.join)(dir, `sendkeys-${sessionKey}.log`), `${line}
`, "utf-8");
    } catch {
    }
  }
  tmux(args, timeout) {
    return execFileAsync(this.tmuxBin, args, { ...EXEC_DEFAULTS, timeout });
  }
  async readSessionPid(sessionKey) {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["display-message", "-p", "-t", sessionKey, "#{pane_pid}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const parsed = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }
  async verifyKilled(sessionKey, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!await this.hasSession(sessionKey)) return true;
      await new Promise((r) => setTimeout(r, this.verifyIntervalMs));
    }
    return !await this.hasSession(sessionKey);
  }
};

// src/hosts/mock-driver.ts
var log7 = makeLogger("daemon.host.mock");

// src/hosts/index.ts
function defaultHostDriver() {
  if (process.platform === "win32") {
    throw new Error("Windows native host driver ships in v0.10.0 F3+. Use WSL2 (tmux) for now.");
  }
  return new TmuxDriver();
}

// src/lock.ts
var import_node_fs5 = require("node:fs");
var import_promises14 = require("node:fs/promises");
var log8 = makeLogger("daemon.lock");
var LockAcquireError = class extends Error {
  constructor(message, heldBy) {
    super(message);
    this.heldBy = heldBy;
    this.name = "LockAcquireError";
  }
};
function readProcStart(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat4 = (0, import_node_fs5.readFileSync)(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat4.slice(stat4.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(/\s+/);
    const starttime = fields[19];
    return starttime ?? null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e.code;
    return code === "EPERM";
  }
}
function isStale(payload) {
  if (!isProcessAlive(payload.pid)) return true;
  if (process.platform === "linux" && payload.procStart) {
    const currentStart = readProcStart(payload.pid);
    if (currentStart !== null && currentStart !== payload.procStart) return true;
  }
  return false;
}
async function readLock() {
  try {
    const raw = await (0, import_promises14.readFile)(daemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return null;
    log8.warn("lock_read_error", { code, err: String(e) });
    return null;
  }
}
async function acquireLock() {
  const existing = await readLock();
  if (existing) {
    if (isStale(existing)) {
      log8.warn("lock_takeover_stale", { heldBy: existing });
    } else {
      throw new LockAcquireError(
        `daemon.lock held by live pid ${existing.pid} (started ${existing.startedAt})`,
        existing
      );
    }
  }
  const payload = {
    pid: process.pid,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    procStart: readProcStart(process.pid)
  };
  await atomicWriteJson(daemonLockPath(), payload);
  log8.info("lock_acquired", { pid: payload.pid });
  return payload;
}
async function releaseLock() {
  try {
    await (0, import_promises14.unlink)(daemonLockPath());
    log8.info("lock_released");
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log8.warn("lock_release_error", { code, err: String(e) });
  }
}

// src/daemon.ts
var log9 = makeLogger("daemon");
var POLL_INTERVAL_MS = 250;
async function runDaemon(opts) {
  try {
    await acquireLock();
  } catch (e) {
    if (e instanceof LockAcquireError) {
      log9.error("lock_held_by_another_daemon", {
        heldBy: e.heldBy
      });
      process.exitCode = 3;
      return;
    }
    throw e;
  }
  await ensureRpcDirs();
  const state = await loadState(opts.daemonVersion);
  await saveState(state);
  const hostDriver = opts.hostDriver ?? defaultHostDriver();
  await writeDaemonEvent("daemon_started", {
    daemonVersion: opts.daemonVersion,
    pid: process.pid,
    stateVersion: state.stateVersion,
    peerCount: Object.keys(state.peers).length
  });
  await startHeartbeat();
  let stopping = false;
  let pollTimer = null;
  const shutdown = async (signal, code = 0) => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearInterval(pollTimer);
    stopHeartbeat();
    await writeDaemonEvent("daemon_stopping", { signal });
    await releaseLock();
    await writeDaemonEvent("daemon_stopped", { signal });
    process.exitCode = code;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    log9.info("sighup_reload_stub", { note: "config reload lands in v0.10.0-beta" });
  });
  process.on("SIGPIPE", () => void 0);
  const drainQueue = async () => {
    if (stopping) return;
    const pending = await listPendingRequests();
    for (const fileName of pending) {
      if (stopping) return;
      const fileId = fileName.replace(/\.json$/, "");
      const req = await readRequest(fileName);
      if (!req) {
        await markRequestDone(fileId);
        await writeEvent({
          event: "request_malformed",
          level: "warn",
          requestId: fileId
        });
        continue;
      }
      if (req.id !== fileId) {
        log9.warn("request_id_filename_mismatch", { fileId, envelopeId: req.id });
      }
      if (!await markRequestDone(fileId)) {
        await writeEvent({
          event: "request_claim_failed",
          level: "error",
          requestId: fileId,
          details: { tool: req.tool, note: "not dispatched \u2014 would re-run on next tick" }
        });
        continue;
      }
      await writeEvent({
        event: "request_received",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool }
      });
      const startedAt = Date.now();
      const result = await dispatch(req, {
        state,
        hostDriver,
        daemonVersion: opts.daemonVersion
      });
      await writeResult(result);
      await writeEvent({
        event: "request_completed",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { tool: req.tool, outcome: result.outcome, durationMs: Date.now() - startedAt }
      });
    }
  };
  const processQueue = guardReentrancy(
    async () => {
      if (stopping) return;
      await drainQueue();
    },
    {
      // Log on a doubling curve — a 120 s handler drops ~480 ticks and the
      // journal must show the stall without 4 lines per second.
      onSkip: (skipped) => {
        if (isPowerOfTwo(skipped)) log9.debug("queue_tick_skipped_busy", { skipped });
      },
      onError: (e) => log9.error("queue_error", { err: String(e) })
    }
  );
  if (opts.once) {
    await processQueue();
    await shutdown("once");
    return;
  }
  pollTimer = setInterval(() => {
    void processQueue();
  }, POLL_INTERVAL_MS);
}

// src/install.ts
var import_node_child_process2 = require("node:child_process");
var import_promises15 = require("node:fs/promises");
var import_node_os4 = require("node:os");
var import_node_path15 = require("node:path");
var log10 = makeLogger("daemon.install");
var UNIT_NAME = "claude-bridge-daemon.service";
function systemdUserDir() {
  return (0, import_node_path15.join)((0, import_node_os4.homedir)(), ".config", "systemd", "user");
}
function unitPath() {
  return (0, import_node_path15.join)(systemdUserDir(), UNIT_NAME);
}
function assertLinux() {
  if (process.platform !== "linux") {
    throw new Error(
      "claude-bridge-daemon install --systemd is Linux-only in v0.10.0-alpha. macOS launchd and Windows Task Scheduler ship in v0.10.0 F3."
    );
  }
}
function resolveDaemonBin() {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("process.argv[1] missing \u2014 cannot determine daemon binary path");
  if (!argv1.startsWith("/")) return (0, import_node_path15.resolve)(process.cwd(), argv1);
  return argv1;
}
async function readTemplate() {
  const anchor = resolveDaemonBin();
  const anchorDir = (0, import_node_path15.dirname)(anchor);
  const candidates = [
    (0, import_node_path15.resolve)(anchorDir, "..", "templates", UNIT_NAME),
    (0, import_node_path15.resolve)(anchorDir, "templates", UNIT_NAME)
  ];
  for (const candidate of candidates) {
    try {
      return await (0, import_promises15.readFile)(candidate, "utf-8");
    } catch {
    }
  }
  throw new Error(`Systemd unit template not found (looked in ${candidates.join(", ")})`);
}
function findNodeBin() {
  return process.execPath;
}
function deployedDaemonPath() {
  return (0, import_node_path15.join)((0, import_node_os4.homedir)(), ".claude-bridge", "bin", "claude-bridge-daemon.cjs");
}
function deployMetaPath() {
  return (0, import_node_path15.join)((0, import_node_path15.dirname)(deployedDaemonPath()), "deployed-from.json");
}
async function deployDaemonBinary(sourceBin) {
  const target = deployedDaemonPath();
  if ((0, import_node_path15.resolve)(sourceBin) === (0, import_node_path15.resolve)(target)) {
    log10.info("deploy_skipped_same_path", { path: target });
    return target;
  }
  await (0, import_promises15.mkdir)((0, import_node_path15.dirname)(target), { recursive: true });
  await (0, import_promises15.copyFile)(sourceBin, target);
  await (0, import_promises15.chmod)(target, 493);
  try {
    const templateSource = await readTemplate();
    const templateTarget = (0, import_node_path15.join)((0, import_node_path15.dirname)(target), "templates", UNIT_NAME);
    await (0, import_promises15.mkdir)((0, import_node_path15.dirname)(templateTarget), { recursive: true });
    await (0, import_promises15.writeFile)(templateTarget, templateSource, "utf-8");
  } catch (e) {
    log10.warn("template_deploy_failed", { err: String(e) });
  }
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      await (0, import_promises15.readFile)((0, import_node_path15.resolve)((0, import_node_path15.dirname)(sourceBin), "..", "package.json"), "utf-8")
    );
    version = pkg.version ?? "unknown";
  } catch {
  }
  await (0, import_promises15.writeFile)(
    deployMetaPath(),
    `${JSON.stringify({ source: (0, import_node_path15.resolve)(sourceBin), version, deployedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf-8"
  );
  log10.info("daemon_binary_deployed", { source: sourceBin, target, version });
  return target;
}
async function installSystemd() {
  assertLinux();
  const sourceBin = resolveDaemonBin();
  const nodeBin = findNodeBin();
  await ensureBinariesExist(sourceBin, nodeBin);
  const daemonBin = await deployDaemonBinary(sourceBin);
  const template = await readTemplate();
  const rendered = template.replace(/__NODE_BIN__/g, nodeBin).replace(/__DAEMON_BIN__/g, daemonBin);
  await (0, import_promises15.mkdir)(systemdUserDir(), { recursive: true });
  await (0, import_promises15.writeFile)(unitPath(), rendered, "utf-8");
  log10.info("unit_written", { path: unitPath(), execStart: daemonBin });
  runSystemctl("daemon-reload");
  runSystemctl("enable", UNIT_NAME);
  runSystemctl("restart", UNIT_NAME);
  log10.info("daemon_started_via_systemd");
}
async function uninstallSystemd() {
  assertLinux();
  try {
    runSystemctl("stop", UNIT_NAME);
  } catch (e) {
    log10.warn("systemd_stop_failed", { err: String(e) });
  }
  try {
    runSystemctl("disable", UNIT_NAME);
  } catch (e) {
    log10.warn("systemd_disable_failed", { err: String(e) });
  }
  try {
    await (0, import_promises15.unlink)(unitPath());
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log10.warn("unit_unlink_failed", { err: String(e) });
  }
  for (const path of [deployedDaemonPath(), deployMetaPath()]) {
    try {
      await (0, import_promises15.unlink)(path);
    } catch (e) {
      const code = e.code;
      if (code !== "ENOENT") log10.warn("deployed_binary_unlink_failed", { path, err: String(e) });
    }
  }
  runSystemctl("daemon-reload");
  log10.info("uninstalled");
}
function runSystemctl(...args) {
  (0, import_node_child_process2.execFileSync)("systemctl", ["--user", ...args], { stdio: "inherit" });
}
async function ensureBinariesExist(daemonBin, nodeBin) {
  for (const [label, path] of [
    ["daemon", daemonBin],
    ["node", nodeBin]
  ]) {
    try {
      await (0, import_promises15.stat)(path);
    } catch {
      throw new Error(`${label} binary not found at ${path} \u2014 build daemon first (npm run build)`);
    }
  }
}

// src/send.ts
var import_promises16 = require("node:fs/promises");
var EXIT_OK = 0;
var EXIT_PEER = 2;
var EXIT_USAGE = 3;
var EXIT_WRITE = 4;
var SEND_HELP = `Usage: claude-bridge-daemon send --to <peer> --from-label <label> [options]

  --to <peer>           recipient peer id or display name (name must be unique)
  --from-label <label>  who this is from, e.g. "teams:uzaverka"
  --text <text>         message body
  --text-file <path>    read the body from a file, or "-" for stdin
  --kind <kind>         ask | reply | broadcast   (default: ask)
  --thread <id>         correlation id for a multi-turn exchange
  --in-reply-to <id>    msgId this answers

Exit: 0 delivered \xB7 2 recipient not found/ambiguous \xB7 3 bad invocation \xB7 4 write failed
`;
var FLAG_MAP = {
  "--to": "to",
  "--from-label": "fromLabel",
  "--text": "text",
  "--text-file": "textFile",
  "--kind": "kind",
  "--thread": "thread",
  "--in-reply-to": "inReplyTo"
};
function parseSendFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === void 0) continue;
    const key = FLAG_MAP[flag];
    if (!key) return { error: `unknown flag '${flag}'` };
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      return { error: `flag '${flag}' needs a value` };
    }
    out[key] = value;
    i++;
  }
  return out;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
async function runSend(argv, now = Date.now()) {
  const parsed = parseSendFlags(argv);
  if ("error" in parsed) {
    return { code: EXIT_USAGE, stderr: `send: ${parsed.error}

${SEND_HELP}` };
  }
  if (!parsed.to) return { code: EXIT_USAGE, stderr: `send: --to is required

${SEND_HELP}` };
  if (!parsed.fromLabel) {
    return { code: EXIT_USAGE, stderr: `send: --from-label is required

${SEND_HELP}` };
  }
  if (parsed.text !== void 0 && parsed.textFile !== void 0) {
    return { code: EXIT_USAGE, stderr: "send: pass --text or --text-file, not both\n" };
  }
  const kindResult = MessageKindSchema.safeParse(parsed.kind ?? "ask");
  if (!kindResult.success) {
    return {
      code: EXIT_USAGE,
      stderr: `send: --kind must be ask, reply or broadcast (got '${parsed.kind}')
`
    };
  }
  let content;
  if (parsed.textFile !== void 0) {
    try {
      content = parsed.textFile === "-" ? await readStdin() : await (0, import_promises16.readFile)(parsed.textFile, "utf-8");
    } catch (e) {
      return { code: EXIT_USAGE, stderr: `send: cannot read --text-file: ${String(e)}
` };
    }
  } else {
    content = parsed.text ?? "";
  }
  if (content.trim().length === 0) {
    return { code: EXIT_USAGE, stderr: "send: message body is empty\n" };
  }
  const lookup = await resolvePeer(parsed.to);
  if (lookup.outcome === "not_found") {
    return {
      code: EXIT_PEER,
      stderr: `send: no peer with id or name '${parsed.to}' \u2014 check ~/.claude-bridge/status/
`
    };
  }
  if (lookup.outcome === "ambiguous") {
    const ids = lookup.candidates.map((c) => c.id).join(", ");
    return {
      code: EXIT_PEER,
      stderr: `send: '${parsed.to}' matches ${lookup.candidates.length} peers (${ids}) \u2014 address one by id
`
    };
  }
  const peer = lookup.peer;
  const envelope = {
    id: generateMessageId(now),
    from: syntheticSenderId(parsed.fromLabel),
    fromName: parsed.fromLabel,
    to: peer.id,
    toName: peer.displayName ?? peer.name,
    kind: kindResult.data,
    sentAt: new Date(now).toISOString(),
    content,
    ...parsed.thread ? { threadId: parsed.thread } : {},
    ...parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}
  };
  let path;
  try {
    path = await writeEnvelope(envelope);
  } catch (e) {
    return { code: EXIT_WRITE, stderr: `send: could not write the message: ${String(e)}
` };
  }
  await writeEvent({
    event: "external_message_sent",
    by: { sessionId: null, name: envelope.from },
    details: {
      msgId: envelope.id,
      to: peer.id,
      toName: envelope.toName,
      kind: envelope.kind,
      contentLength: content.length,
      // The body is NOT logged — it can carry anything the relay picked up.
      peerHeartbeatAgeMs: peer.lastSeenAgeMs
    }
  });
  return {
    code: EXIT_OK,
    stdout: `${JSON.stringify({
      ok: true,
      msgId: envelope.id,
      to: { id: peer.id, name: envelope.toName },
      from: envelope.from,
      kind: envelope.kind,
      path,
      peerHeartbeatAgeMs: peer.lastSeenAgeMs
    })}
`
  };
}

// src/index.ts
var log11 = makeLogger("daemon.cli");
var DAEMON_VERSION = package_default.version;
var HELP = `claude-bridge-daemon ${DAEMON_VERSION}

Commands:
  run                Run the daemon in the foreground (used by systemd)
  install --systemd  Install and start as a systemd --user service (Linux)
  uninstall --systemd
                     Stop, disable, and remove the systemd --user service
  status             Print daemon lock + heartbeat freshness
  send               Deliver one message into a peer's inbox from outside the
                     fleet (see \`send --help\`)
  version            Print the daemon version
  help               Print this message
`;
async function statusCommand() {
  const lock = await readLock();
  let heartbeatAgeMs = null;
  try {
    const s = await (0, import_promises17.stat)(heartbeatPath());
    heartbeatAgeMs = Date.now() - s.mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
  const alive = lock !== null && heartbeatAgeMs !== null && heartbeatAgeMs < 3e4;
  const report = {
    daemonVersion: DAEMON_VERSION,
    alive,
    lock,
    heartbeatAgeMs
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  process.exitCode = alive ? 0 : 1;
}
async function main(argv) {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "run": {
      await runDaemon({ daemonVersion: DAEMON_VERSION });
      return;
    }
    case "install": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`install requires --systemd flag
${HELP}`);
        process.exitCode = 2;
        return;
      }
      await installSystemd();
      return;
    }
    case "uninstall": {
      if (argv[1] !== "--systemd") {
        process.stderr.write(`uninstall requires --systemd flag
${HELP}`);
        process.exitCode = 2;
        return;
      }
      await uninstallSystemd();
      return;
    }
    case "status": {
      await statusCommand();
      return;
    }
    case "send": {
      if (argv[1] === "--help" || argv[1] === "-h") {
        process.stdout.write(SEND_HELP);
        return;
      }
      const outcome = await runSend(argv.slice(1));
      if (outcome.stdout) process.stdout.write(outcome.stdout);
      if (outcome.stderr) process.stderr.write(outcome.stderr);
      process.exitCode = outcome.code;
      return;
    }
    case "version": {
      process.stdout.write(`${DAEMON_VERSION}
`);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(HELP);
      return;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}
${HELP}`);
      process.exitCode = 2;
    }
  }
}
main(process.argv.slice(2)).catch((e) => {
  log11.error("cli_fatal", { err: String(e) });
  process.exitCode = 1;
});
