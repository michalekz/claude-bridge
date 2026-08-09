#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/index.ts
var import_promises21 = require("node:fs/promises");

// ../../packages/shared/src/atomic-write.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
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
function assertTestWritesStayInTemp(targetPath) {
  if (!process.env["VITEST"]) return;
  const tmp = (0, import_node_os.tmpdir)();
  const resolved = (0, import_node_path.resolve)(targetPath);
  if (resolved.startsWith(`${tmp}/`) || resolved === tmp) return;
  throw new Error(
    `atomicWrite refused: tests may only write under ${tmp}, and this call targets ${resolved}. A test reaching outside the temp root is writing to the real machine \u2014 most likely a missing homedir mock. See the 2026-08-07 registry loss.`
  );
}
async function atomicWrite(targetPath, content, options = {}) {
  assertTestWritesStayInTemp(targetPath);
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
var import_node_os2 = require("node:os");
var import_node_path2 = require("node:path");
function currentPlatform() {
  const p = (0, import_node_os2.platform)();
  if (p === "linux" || p === "darwin" || p === "win32") return p;
  throw new Error(`Unsupported platform: ${p}`);
}
function claudeHome() {
  return (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".claude");
}
function projectsRoot() {
  return (0, import_node_path2.join)(claudeHome(), "projects");
}
function encodeProjectDir(absoluteCwd, plat = currentPlatform()) {
  const dropColon = plat === "win32" ? absoluteCwd.replace(/:/g, "-") : absoluteCwd;
  const collapseSeparators = plat === "win32" ? dropColon.replace(/[\\/]+/g, "-") : dropColon.replace(/\/+/g, "-");
  return collapseSeparators.replace(/[^a-zA-Z0-9-]/g, "-");
}
function projectDir(absoluteCwd) {
  return (0, import_node_path2.join)(projectsRoot(), encodeProjectDir((0, import_node_path2.resolve)(absoluteCwd)));
}
function sessionFile(absoluteCwd, sessionId) {
  return (0, import_node_path2.join)(projectDir(absoluteCwd), `${sessionId}.jsonl`);
}
function bridgeRoot() {
  return (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".claude-bridge");
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
  version: "0.11.25",
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

// src/config-cli.ts
var import_node_crypto3 = require("node:crypto");
var import_promises7 = require("node:fs/promises");

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

// src/handlers/peer-ref.ts
function shortFormOf(record) {
  const team = record.desired.team;
  if (!team) return null;
  const prefix = `${team}-`;
  if (!record.observed.name.startsWith(prefix)) return null;
  const short = record.observed.name.slice(prefix.length);
  return short.length > 0 ? short : null;
}
function resolvePeerRef(peers, ref, callerTeam) {
  const byId = peers[ref];
  if (byId) return { kind: "found", handle: ref, record: byId };
  const exact = Object.entries(peers).filter(([, rec]) => rec.observed.name === ref);
  if (exact.length === 1) {
    const [handle, record] = exact[0];
    return { kind: "found", handle, record };
  }
  if (exact.length > 1) return ambiguous(exact);
  const short = Object.entries(peers).filter(([, rec]) => shortFormOf(rec) === ref);
  if (short.length === 0) return { kind: "not_found" };
  if (short.length === 1) {
    const [handle, record] = short[0];
    return { kind: "found", handle, record };
  }
  if (callerTeam) {
    const own = short.filter(([, rec]) => rec.desired.team === callerTeam);
    if (own.length === 1) {
      const [handle, record] = own[0];
      return { kind: "found", handle, record };
    }
  }
  return ambiguous(short);
}
function ambiguous(matches) {
  return {
    kind: "ambiguous",
    candidates: matches.map(([handle, rec]) => ({
      handle,
      name: rec.observed.name,
      tmuxTarget: rec.observed.tmuxTarget,
      status: rec.observed.status
    }))
  };
}
function ambiguousPeerMessage(ref, candidates) {
  const distinctNames = new Set(candidates.map((c) => c.name));
  const list = distinctNames.size === candidates.length ? candidates.map((c) => c.name).join(", ") : candidates.map((c) => `${c.name} [${c.handle}]`).join(", ");
  return `'${ref}' matches ${candidates.length} peers \u2014 refusing to guess which one. Use the full name: ${list}`;
}

// src/state.ts
var import_promises5 = require("node:fs/promises");

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

// src/hosts/driver.ts
var WINDOW_ID = /^@\d+$/;
function parseHostTarget(key) {
  if (WINDOW_ID.test(key)) return { kind: "window", windowId: key };
  return { kind: "session", session: sanitizeSessionKey(key) };
}
function formatHostTarget(t) {
  return t.kind === "window" ? t.windowId : t.session;
}
function canonicalHostTarget(key) {
  return formatHostTarget(parseHostTarget(key));
}
function trustCanonicalTarget(fromHost) {
  return fromHost;
}
var UNSAFE_TARGET_CHARS = /[^A-Za-z0-9_-]/g;
function sanitizeSessionKey(rawName) {
  const sanitized = rawName.replace(UNSAFE_TARGET_CHARS, "_");
  if (sanitized.length === 0) {
    throw new Error(`Cannot derive a tmux target from '${rawName}' \u2014 nothing safe remained`);
  }
  return sanitized;
}

// src/state.ts
var log3 = makeLogger("daemon.state");
var STATE_VERSION = 3;
var REPAIR_HARVEST_PROVENANCE = "revoke-harvest-stamps-pre-0.11.1";
var REPAIR_DERIVED_LABELS = "revoke-derived-labels-pre-0.11.2";
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
function revokeUntrustedHarvestStamps(doc) {
  if (hasRepair(doc, REPAIR_HARVEST_PROVENANCE)) return 0;
  let cleared = 0;
  for (const rec of Object.values(doc.peers)) {
    if (rec.observed.harvestedAt === void 0) continue;
    rec.observed.harvestedAt = void 0;
    cleared++;
  }
  markRepair(doc, REPAIR_HARVEST_PROVENANCE);
  doc.harvestProvenanceRevokedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (cleared > 0) log3.warn("harvest_stamps_revoked", { cleared, reason: "written_before_0_11_1" });
  return cleared;
}
function hasRepair(doc, id) {
  if (doc.repairsApplied?.includes(id)) return true;
  return id === REPAIR_HARVEST_PROVENANCE && doc.harvestProvenanceRevokedAt !== void 0;
}
function markRepair(doc, id) {
  doc.repairsApplied = [...doc.repairsApplied ?? [], id];
}
function revokeDerivedLabels(doc) {
  if (hasRepair(doc, REPAIR_DERIVED_LABELS)) return 0;
  let cleared = 0;
  for (const rec of Object.values(doc.peers)) {
    const { label, team } = rec.desired;
    if (label === void 0 || team === void 0) continue;
    if (label !== rec.observed.name) continue;
    if (!label.startsWith(`${team}-`)) continue;
    rec.desired.label = void 0;
    cleared++;
  }
  markRepair(doc, REPAIR_DERIVED_LABELS);
  if (cleared > 0) log3.warn("derived_labels_revoked", { cleared, reason: "written_before_0_11_2" });
  return cleared;
}
function repairHarvestedEnv(peers) {
  for (const record of Object.values(peers)) {
    const env = record.observed.spawnEnv;
    if (!env) continue;
    const cleaned = stripHostProvided(env);
    if (Object.keys(cleaned).length === Object.keys(env).length) continue;
    log3.info("spawn_env_repaired", {
      handle: record.handle,
      dropped: HOST_PROVIDED_VARS.filter((v) => v in env)
    });
    record.observed.spawnEnv = cleaned;
  }
  return peers;
}
function migrateV2ToV3(v2Peers) {
  const peers = {};
  const disagreed = [];
  let migrated = 0;
  for (const [id, old] of Object.entries(v2Peers)) {
    const self = typeof old["sessionId"] === "string" ? old["sessionId"] : null;
    if (self !== null && self !== id) disagreed.push(`${id} (record said '${self}')`);
    const { sessionId: _dropped, ...rest } = old;
    peers[id] = { ...rest, handle: id };
    migrated++;
  }
  return { peers, migrated, disagreed };
}
function looksV2(peers) {
  const first = Object.values(peers)[0];
  if (!first || typeof first !== "object") return false;
  return "observed" in first && !("handle" in first);
}
function looksLegacy(peers) {
  const first = Object.values(peers)[0];
  if (!first || typeof first !== "object") return false;
  return !("observed" in first) && "name" in first;
}
function migrateV1ToV2(legacyPeers) {
  const peers = {};
  let migrated = 0;
  for (const [id, old] of Object.entries(legacyPeers)) {
    const desired = {};
    if (old.team !== void 0) desired.team = old.team;
    if (old.model !== void 0) desired.model = old.model;
    if (old.accountProfile !== void 0) desired.accountProfile = old.accountProfile;
    if (old.cwd !== void 0) desired.cwd = old.cwd;
    if (old.command !== void 0) desired.command = old.command;
    if (old.spawnArgs !== void 0) desired.spawnArgs = old.spawnArgs;
    if (old.homeSession !== void 0) desired.homeSession = old.homeSession;
    const observed = {
      name: old.name,
      hostDriver: old.hostDriver,
      // TRUSTED, not sanitised — and that is a correction to my own first
      // instinct here (R3, v0.11.21). A v1 record predates the T1 fix, so it
      // COULD hold a raw display name; it could equally hold a genuine host
      // address with a space, which is what an adopted peer's target looks
      // like. Nothing distinguishes the two after the fact, and sanitising
      // would silently rename the second kind to close the first.
      //
      // So the migration carries the value as written and lets `team_reconcile`
      // say so if it matches nothing on the host. A drift entry a human can
      // read beats an address quietly rewritten during an upgrade.
      tmuxTarget: old.tmuxTarget === null ? null : trustCanonicalTarget(old.tmuxTarget),
      pid: old.pid,
      status: old.status,
      model: old.model,
      startedAt: old.startedAt,
      lastUpdatedAt: old.lastUpdatedAt
    };
    if (old.stoppedCleanly !== void 0) observed.stoppedCleanly = old.stoppedCleanly;
    if (old.adopted !== void 0) observed.adopted = old.adopted;
    if (old.spawnEnv !== void 0) observed.spawnEnv = old.spawnEnv;
    peers[id] = { handle: old.sessionId, desired, observed };
    migrated++;
  }
  return { peers, migrated };
}
async function loadState(daemonVersion) {
  try {
    const raw = await (0, import_promises5.readFile)(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    let onDisk = parsed.stateVersion ?? 0;
    if (onDisk > STATE_VERSION) throw new StateVersionMismatch(onDisk, STATE_VERSION);
    const contentSays = looksLegacy(parsed.peers ?? {}) ? 1 : looksV2(parsed.peers ?? {}) ? 2 : null;
    if (contentSays !== null && contentSays !== onDisk) {
      log3.warn("state_version_stamp_disagrees_with_content", {
        stamped: onDisk,
        treatingAs: contentSays,
        hint: contentSays === 1 ? "records are flat; migrating on content rather than crashing on the stamp" : "records name themselves `sessionId`; migrating on content rather than trusting the stamp"
      });
      onDisk = contentSays;
    }
    if (onDisk < STATE_VERSION) {
      if (onDisk !== 1 && onDisk !== 2) {
        throw new Error(
          `state.json stateVersion=${onDisk} has no migration path to ${STATE_VERSION}; refusing to start rather than discard ${Object.keys(parsed.peers ?? {}).length} peers`
        );
      }
      const backup = `${stateFilePath()}.v${onDisk}.${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.bak`;
      await (0, import_promises5.writeFile)(backup, raw, "utf-8");
      const viaV2 = onDisk === 1 ? migrateV1ToV2(parsed.peers).peers : parsed.peers;
      const { peers, migrated, disagreed } = migrateV2ToV3(
        viaV2
      );
      if (disagreed.length > 0) {
        log3.warn("state_handle_disagreed_with_key", { peers: disagreed, resolvedAs: "key" });
      }
      log3.warn("state_migrated", { from: onDisk, to: STATE_VERSION, peers: migrated, backup });
      const fresh = {
        stateVersion: STATE_VERSION,
        daemonVersion,
        daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
        peers: repairHarvestedEnv(peers)
      };
      revokeUntrustedHarvestStamps(fresh);
      revokeDerivedLabels(fresh);
      return fresh;
    }
    const doc = {
      stateVersion: STATE_VERSION,
      daemonVersion,
      daemonStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
      peers: repairHarvestedEnv(parsed.peers ?? {}),
      // Carried forward, or the one-time pass would run on every start and
      // wipe stamps a v0.11.1 daemon had legitimately written.
      ...parsed.harvestProvenanceRevokedAt !== void 0 ? { harvestProvenanceRevokedAt: parsed.harvestProvenanceRevokedAt } : {},
      ...parsed.repairsApplied !== void 0 ? { repairsApplied: parsed.repairsApplied } : {}
    };
    revokeUntrustedHarvestStamps(doc);
    revokeDerivedLabels(doc);
    return doc;
  } catch (e) {
    if (e instanceof StateVersionMismatch) throw e;
    const code = e.code;
    if (code === "ENOENT") {
      log3.info("state_missing_bootstrap");
      return emptyState(daemonVersion);
    }
    log3.error("state_load_error", { err: String(e) });
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

// src/handlers/control-config.ts
var PEER_SETTABLE = ["label", "windowIndex", "model", "accountProfile", "role"];
var PeerSetSchema = external_exports.object({
  label: external_exports.string().min(1).max(64).optional(),
  /**
   * Declared role. `velitel` is the only value the daemon acts on today: it
   * orders that peer LAST in a team stop or restart, because a coordinator
   * goes down after the peers it coordinates.
   *
   * Nullable so a declaration can be withdrawn, which is not the same as
   * never having declared one — the peer then falls back to name matching.
   */
  role: external_exports.string().min(1).max(32).nullable().optional(),
  // A window position is an index, not an opinion. Negative is meaningless
  // and a huge value is a typo, not a request.
  windowIndex: external_exports.number().int().min(0).max(999).optional(),
  model: external_exports.string().min(1).nullable().optional(),
  accountProfile: external_exports.string().min(1).nullable().optional()
  /**
   * `team` is NOT here, and its absence is the decision.
   *
   * It looks like a field and behaves like an operation. Declaring a new team
   * would leave the record inconsistent in three places at once, none of
   * which this tool can fix:
   *
   *   - `homeSession` still names the OLD team, so the next restart puts the
   *     peer back in the old tmux session
   *   - the tmux window does not move
   *   - the derived label stops matching — `mic-tester` in team `plt` has no
   *     prefix to strip, so it falls back to the fully qualified name, which
   *     is the exact regression v0.11.2 spent a release cleaning up
   *
   * Moving a peer between teams is lifecycle work (window, home session,
   * label), and lifecycle work belongs to `team_adopt` / `team_release` or a
   * future `peer_move`. Ratified with ai-designer 2026-08-06 as part of the
   * edge-test matrix (case A6, previously "behaviour undefined").
   */
}).strict();
var ControlConfigArgsSchema = external_exports.object({
  /** Peer to read or write. Resolved by id, full name, or short name in the caller's team. */
  peer: external_exports.string().min(1).optional(),
  /** Read every peer of this team. Read-only — bulk writes are not this tool's job. */
  team: external_exports.string().min(1).optional(),
  /** Omit to read. Present to declare. */
  set: PeerSetSchema.optional(),
  /**
   * Withdraw a declaration, returning the key to "nobody has said".
   *
   * A separate list rather than `set: {windowIndex: null}`, because those are
   * two different statements and the drift report depends on telling them
   * apart: an UNDECLARED windowIndex reports no drift no matter where the
   * window sits, while a declared one that disagrees with reality does.
   * Overloading null would fold "no opinion" into "an opinion whose value is
   * empty" — the same conflation, one level up, that this release exists to
   * undo (#80).
   */
  unset: external_exports.array(external_exports.enum(PEER_SETTABLE)).nonempty().optional(),
  /**
   * Preview without writing.
   *
   * Present on every call rather than only the dangerous ones: a caller
   * should never have to remember WHICH operations honour it.
   */
  dryRun: external_exports.boolean().default(false),
  reason: external_exports.string().optional()
}).strict().refine((a) => !(a.peer !== void 0 && a.team !== void 0), {
  message: "pass `peer` or `team`, not both"
}).refine((a) => !((a.set !== void 0 || a.unset !== void 0) && a.peer === void 0), {
  message: "`set`/`unset` require `peer` \u2014 declaring intent for a whole team at once is not supported"
}).refine(
  (a) => !(a.set !== void 0 && a.unset !== void 0 && a.unset.some((k) => k in (a.set ?? {}))),
  { message: "the same key cannot be both set and unset in one call" }
);
function viewOf(record) {
  const drift = [];
  const dIdx = record.desired.windowIndex;
  const oIdx = record.observed.windowIndex;
  if (dIdx !== void 0 && oIdx !== void 0 && dIdx !== oIdx) {
    drift.push({
      field: "windowIndex",
      desired: dIdx,
      observed: oIdx,
      resolve: {
        assert: `move the window to index ${dIdx} (no daemon-side assert yet; today: tmux move-window)`,
        adopt: `accept reality \u2014 control_config peer:"${record.observed.name}" set:{windowIndex:${oIdx}}`
      }
    });
  }
  const dModel = record.desired.model;
  const oModel = record.observed.model;
  if (dModel != null && oModel != null && dModel !== oModel) {
    drift.push({
      field: "model",
      desired: dModel,
      observed: oModel,
      resolve: {
        assert: `switch the peer to ${dModel} (no daemon-side assert yet; today: send /model by hand)`,
        adopt: `accept reality \u2014 control_config peer:"${record.observed.name}" set:{model:"${oModel}"}`
      }
    });
  }
  return {
    handle: record.handle,
    name: record.observed.name,
    desired: { ...record.desired },
    observed: {
      windowIndex: record.observed.windowIndex ?? null,
      model: record.observed.model,
      status: record.observed.status,
      tmuxTarget: record.observed.tmuxTarget,
      harvestedAt: record.observed.harvestedAt ?? null
    },
    drift
  };
}
function callerTeamOf(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}
async function handleControlConfig(req, ctx) {
  const parsed = ControlConfigArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  if (args.team !== void 0) {
    const members = Object.values(ctx.state.peers).filter((p) => p.desired.team === args.team);
    if (members.length === 0) {
      return errResult(req.id, req.tool, "team_not_found", `No peers under team '${args.team}'`, {
        team: args.team,
        knownTeams: [
          ...new Set(
            Object.values(ctx.state.peers).map((p) => p.desired.team).filter((t) => t !== void 0)
          )
        ]
      });
    }
    return okResult(req.id, req.tool, {
      team: args.team,
      settableKeys: PEER_SETTABLE,
      peers: members.map(viewOf)
    });
  }
  if (args.peer === void 0) {
    return okResult(req.id, req.tool, {
      settableKeys: PEER_SETTABLE,
      peers: Object.values(ctx.state.peers).map(viewOf)
    });
  }
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
  if (resolved.kind !== "found") {
    return errResult(req.id, req.tool, "peer_not_found", `No peer '${args.peer}' in daemon state`, {
      peer: args.peer
    });
  }
  const record = resolved.record;
  if (args.set === void 0 && args.unset === void 0) {
    return okResult(req.id, req.tool, { settableKeys: PEER_SETTABLE, peer: viewOf(record) });
  }
  const changes = [];
  for (const key of args.unset ?? []) {
    const from = record.desired[key];
    if (from === void 0) continue;
    changes.push({ key, from, to: null });
  }
  for (const [key, to] of Object.entries(args.set ?? {})) {
    if (to === void 0) continue;
    const from = record.desired[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ key, from: from ?? null, to });
  }
  if (changes.length === 0) {
    return okResult(req.id, req.tool, {
      dryRun: args.dryRun,
      changed: [],
      note: "Every requested value already matches what is declared. Nothing written.",
      peer: viewOf(record)
    });
  }
  if (args.dryRun) {
    await writeEvent({
      event: "control_config_preview",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: record.handle, changes, reason: args.reason ?? null }
    });
    return okResult(req.id, req.tool, {
      dryRun: true,
      changed: changes,
      peer: viewOf(record),
      note: "Nothing written. Re-run without dryRun to declare these values."
    });
  }
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[record.handle];
    if (!rec) return;
    if (args.set) Object.assign(rec.desired, args.set);
    for (const key of args.unset ?? []) {
      delete rec.desired[key];
    }
    rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
  await writeEvent({
    event: "control_config_set",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { handle: record.handle, changes, reason: args.reason ?? null }
  });
  const after = ctx.state.peers[record.handle];
  return okResult(req.id, req.tool, {
    dryRun: false,
    changed: changes,
    peer: after ? viewOf(after) : null,
    // Said plainly, because "I set windowIndex and nothing moved" is otherwise
    // read as a bug rather than as the documented boundary of this release.
    // No version number in a promise (R3, v0.11.21). This one said "lands in
    // v0.11.1" and was still saying it at v0.11.20 — a promise with a version
    // in it goes stale exactly the way a count written in prose does. The
    // capability is still wanted, so the sentence stays; only the date goes.
    note: "Declared. Nothing in the world was changed \u2014 this tool records intent and reports drift. Asserting intent is not implemented yet; each drift entry names both ways out."
  });
}

// src/lock.ts
var import_node_fs = require("node:fs");
var import_promises6 = require("node:fs/promises");
var log4 = makeLogger("daemon.lock");
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
    const stat5 = (0, import_node_fs.readFileSync)(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat5.slice(stat5.lastIndexOf(")") + 1).trim();
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
    const raw = await (0, import_promises6.readFile)(daemonLockPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return null;
    log4.warn("lock_read_error", { code, err: String(e) });
    return null;
  }
}
async function acquireLock() {
  const existing = await readLock();
  if (existing) {
    if (isStale(existing)) {
      log4.warn("lock_takeover_stale", { heldBy: existing });
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
  log4.info("lock_acquired", { pid: payload.pid });
  return payload;
}
async function releaseLock() {
  try {
    await (0, import_promises6.unlink)(daemonLockPath());
    log4.info("lock_released");
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log4.warn("lock_release_error", { code, err: String(e) });
  }
}

// src/poll.ts
async function pollUntil(probe, opts) {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let attempts = 0;
  for (; ; ) {
    if (attempts > 0 && opts.abort) {
      const verdict = opts.abort();
      if (verdict.aborted) {
        return {
          kind: "aborted",
          reason: verdict.reason,
          waitedMs: Date.now() - started,
          attempts
        };
      }
    }
    attempts++;
    const value = await probe();
    if (value !== null && value !== void 0) {
      return { kind: "hit", value, waitedMs: Date.now() - started, attempts };
    }
    if (opts.maxAttempts !== void 0 && attempts >= opts.maxAttempts) break;
    if (Date.now() >= deadline) break;
    await new Promise(
      (r) => setTimeout(r, Math.min(opts.pollMs, Math.max(0, deadline - Date.now())))
    );
  }
  return {
    kind: "expired",
    waitedMs: Date.now() - started,
    attempts,
    timeoutMs: opts.timeoutMs
  };
}

// src/config-cli.ts
var CONFIG_HELP = `claude-bridge-daemon config \u2014 read and declare peer intent

Usage:
  config                              Show declared intent + drift for every peer
  config <peer>                       Show one peer (id, full name, or short name)
  config --team <team>                Show every peer of a team
  config <peer> --set <k>=<v> [...]   Declare values
  config <peer> --unset <k> [...]     Withdraw a declaration (NOT the same as
                                      setting it empty \u2014 an undeclared value
                                      reports no drift at all)
  config <peer> --set <k>=<v> --dry-run
                                      Show what would change, write nothing

Settable keys: ${PEER_SETTABLE.join(", ")}
  windowIndex is RECORDED and drift is reported. It does not move any window
  in v0.11.0 \u2014 asserting it is v0.11.1, behind an explicit opt-in.

Examples:
  config mic-tester
  config velitel --set label=velitel --dry-run
  config ai-designer --set model=claude-opus-5 --reason "post-soak bump"
`;
var NUMERIC_KEYS = /* @__PURE__ */ new Set(["windowIndex"]);
function parseConfigArgs(argv) {
  const out = { set: {}, unset: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--team") {
      out.team = argv[++i];
    } else if (a === "--unset") {
      const key = argv[++i];
      if (!key || key.startsWith("--")) throw new Error("--unset expects a key name");
      out.unset.push(key);
    } else if (a === "--reason") {
      out.reason = argv[++i];
    } else if (a === "--set") {
      const pair = argv[++i];
      if (!pair || !pair.includes("=")) {
        throw new Error(`--set expects <key>=<value>, got ${pair ?? "nothing"}`);
      }
      const idx = pair.indexOf("=");
      const key = pair.slice(0, idx);
      const raw = pair.slice(idx + 1);
      if (NUMERIC_KEYS.has(key)) {
        const n = Number(raw);
        if (!Number.isInteger(n)) throw new Error(`${key} expects an integer, got '${raw}'`);
        out.set[key] = n;
      } else if (raw === "null") {
        out.set[key] = null;
      } else {
        out.set[key] = raw;
      }
    } else if (a?.startsWith("--")) {
      throw new Error(`unknown flag ${a}`);
    } else if (a !== void 0 && out.peer === void 0) {
      out.peer = a;
    } else {
      throw new Error(`unexpected argument '${a}'`);
    }
  }
  return out;
}
function generateRequestId() {
  return `cli-${Date.now().toString(36)}-${(0, import_node_crypto3.randomBytes)(4).toString("hex")}`;
}
var CLI_RESULT_POLL_MS = 200;
async function pollForResult(requestId, timeoutMs) {
  const outcome = await pollUntil(
    async () => {
      try {
        return { value: JSON.parse(await (0, import_promises7.readFile)(resultPath(requestId), "utf-8")) };
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        return null;
      }
    },
    { timeoutMs, pollMs: CLI_RESULT_POLL_MS }
  );
  return outcome.kind === "hit" ? outcome.value.value : null;
}
async function runConfig(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(CONFIG_HELP);
    return 0;
  }
  let parsed;
  try {
    parsed = parseConfigArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}

${CONFIG_HELP}`);
    return 2;
  }
  const lock = await readLock();
  if (!lock) {
    process.stderr.write(
      "daemon is not running \u2014 config goes through the daemon so that state.json keeps a single writer\n"
    );
    return 1;
  }
  const args = { dryRun: parsed.dryRun };
  if (parsed.peer !== void 0) args["peer"] = parsed.peer;
  if (parsed.team !== void 0) args["team"] = parsed.team;
  if (parsed.reason !== void 0) args["reason"] = parsed.reason;
  if (Object.keys(parsed.set).length > 0) args["set"] = parsed.set;
  if (parsed.unset.length > 0) args["unset"] = parsed.unset;
  const id = generateRequestId();
  await atomicWriteJson(requestPath(id), {
    schemaVersion: 1,
    id,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    tool: "control_config",
    args,
    // The CLI is not a peer. Saying so keeps short-name resolution honest —
    // there is no caller team to search, so a bare `velitel` is ambiguous here
    // and the error will say which ones it matched.
    requestedBy: { sessionId: `cli:${process.pid}`, name: "cli" }
  });
  const result = await pollForResult(id, 1e4);
  if (result === null) {
    process.stderr.write(`no result within 10s (request ${id}); daemon may be busy
`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  const outcome = result.outcome;
  return outcome === "error" ? 1 : 0;
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
var import_promises12 = require("node:fs/promises");

// src/compact-verify.ts
var import_promises8 = require("node:fs/promises");
var import_node_path6 = require("node:path");
var log5 = makeLogger("daemon.compact-verify");
function statuslineFile(sessionId) {
  return (0, import_node_path6.join)(bridgeRoot(), "live", "statusline", `${sessionId}.json`);
}
var DEFAULT_VERIFY_TIMEOUT_MS = 18e4;
var DEFAULT_VERIFY_POLL_MS = 2e3;
var COMPACT_RACE_PERCENT = 85;
async function readPeerContext(sessionId) {
  const empty = {
    usedPercentage: null,
    transcriptPath: null,
    capturedAt: null
  };
  try {
    const raw = await (0, import_promises8.readFile)(statuslineFile(sessionId), "utf-8");
    const doc = JSON.parse(raw);
    return {
      usedPercentage: doc.payload?.context_window?.used_percentage ?? null,
      transcriptPath: doc.payload?.transcript_path ?? null,
      capturedAt: doc.capturedAt ?? null
    };
  } catch {
    return empty;
  }
}
async function markTranscript(path) {
  try {
    return (await (0, import_promises8.stat)(path)).size;
  } catch {
    return 0;
  }
}
async function readSince(path, offset) {
  let handle = null;
  try {
    const size = (await (0, import_promises8.stat)(path)).size;
    if (size < offset) return { rows: [], offset: size };
    if (size === offset) return { rows: [], offset };
    handle = await (0, import_promises8.open)(path, "r");
    const buf = Buffer.alloc(size - offset);
    await handle.read(buf, 0, buf.length, offset);
    const text = buf.toString("utf-8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { rows: [], offset };
    const rows = [];
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
      }
    }
    return { rows, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } catch {
    return { rows: [], offset };
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
function compactOf(row) {
  const meta = row.compactMetadata;
  if (!meta?.trigger) return null;
  return {
    trigger: meta.trigger,
    at: row.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
    pre: typeof meta.preTokens === "number" ? meta.preTokens : null,
    post: typeof meta.postTokens === "number" ? meta.postTokens : null
  };
}
function isEnqueueOf(row, payload) {
  if (row.type !== "queue-operation" || row.operation !== "enqueue") return false;
  const c = row.content;
  const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
  return text.includes(payload);
}
async function watchForCompact(opts) {
  const pollMs = opts.pollMs ?? DEFAULT_VERIFY_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep3 = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const startedMs = now();
  const deadline = startedMs + opts.timeoutMs;
  let offset = opts.fromOffset;
  let queuedAt = null;
  let auto = null;
  for (; ; ) {
    const { rows, offset: next } = await readSince(opts.transcriptPath, offset);
    offset = next;
    for (const row of rows) {
      if (queuedAt === null && isEnqueueOf(row, opts.payload)) {
        queuedAt = row.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
        log5.warn("compact_queued", { queuedAt, payload: opts.payload });
        continue;
      }
      const c = compactOf(row);
      if (!c) continue;
      if (c.trigger === "manual") {
        return {
          kind: "executed",
          at: c.at,
          preTokens: c.pre,
          postTokens: c.post,
          queuedAt,
          preemptedByAuto: auto
        };
      }
      if (c.trigger === "auto" && auto === null) {
        auto = { at: c.at, preTokens: c.pre, postTokens: c.post };
        log5.error("compact_preempted_by_auto", auto);
      }
    }
    if (now() >= deadline) {
      const waitedMs = now() - startedMs;
      if (auto) return { kind: "preempted-unresolved", auto, queuedAt, waitedMs };
      if (queuedAt) return { kind: "queued-unresolved", queuedAt, waitedMs };
      return { kind: "silent", waitedMs };
    }
    await sleep3(pollMs);
  }
}

// src/event-subscribers.ts
var import_node_crypto4 = require("node:crypto");
var import_promises9 = require("node:fs/promises");
var import_node_path7 = require("node:path");
var log6 = makeLogger("daemon.subscribers");
function subscribersFilePath() {
  return (0, import_node_path7.join)(controlDir(), "subscribers.json");
}
async function readSubscribers() {
  try {
    const raw = await (0, import_promises9.readFile)(subscribersFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.subscribers ?? [];
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") return [];
    log6.warn("subscribers_read_error", { err: String(e) });
    return [];
  }
}
function generateMsgId() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto4.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function publishLifecycleEvent(payload) {
  const subscribers = await readSubscribers();
  const interested = subscribers.filter((s) => s.events.includes(payload.event));
  if (interested.length === 0) return;
  for (const sub of interested) {
    const msgId = generateMsgId();
    try {
      await writeEnvelope({
        id: msgId,
        from: syntheticSenderId("control-plane-daemon"),
        fromName: "control-plane-daemon",
        to: sub.peerId,
        kind: "broadcast",
        sentAt: (/* @__PURE__ */ new Date()).toISOString(),
        content: [
          `[control-plane] ${payload.event} \u2014 ${payload.handle} (${payload.sessionKey})`,
          "",
          JSON.stringify(payload.details, null, 2)
        ].join("\n")
      });
    } catch (e) {
      log6.warn("subscriber_dispatch_failed", {
        subscriber: sub.peerId,
        event: payload.event,
        err: String(e)
      });
    }
  }
}

// src/handlers/ack-protocol.ts
var import_promises10 = require("node:fs/promises");
var import_node_path8 = require("node:path");
var ACK_FILENAME_EXTENSION = ".json";
async function fileExists(path) {
  try {
    await (0, import_promises10.access)(path);
    return true;
  } catch {
    return false;
  }
}
async function verifyAckFile(path, requestedAtMs, threadId) {
  let stat5;
  try {
    stat5 = await (0, import_promises10.lstat)(path);
  } catch {
    return { accepted: false, reason: "none" };
  }
  if (stat5.mtimeMs < requestedAtMs - 1e3) {
    return { accepted: false, reason: "too_old", writtenAt: new Date(stat5.mtimeMs).toISOString() };
  }
  let ackThreadId = null;
  try {
    const parsed = JSON.parse(await (0, import_promises10.readFile)(path, "utf-8"));
    if (typeof parsed.threadId === "string") ackThreadId = parsed.threadId;
  } catch {
  }
  if (ackThreadId !== null && ackThreadId !== threadId) {
    return {
      accepted: false,
      reason: "wrong_thread",
      ackThreadId,
      writtenAt: new Date(stat5.mtimeMs).toISOString()
    };
  }
  return {
    accepted: true,
    reason: "fresh",
    ackThreadId,
    writtenAt: new Date(stat5.mtimeMs).toISOString()
  };
}
function createAckChannel(channel) {
  const dir = () => (0, import_node_path8.join)(controlDir(), channel);
  const path = (sessionId) => (0, import_node_path8.join)(dir(), `${sessionId}${ACK_FILENAME_EXTENSION}`);
  return {
    channel,
    dir,
    path,
    async sweepStale(sessionId, reason) {
      const src = path(sessionId);
      if (!await fileExists(src)) return null;
      const done = (0, import_node_path8.join)(dir(), "done");
      await (0, import_promises10.mkdir)(done, { recursive: true });
      const dest = (0, import_node_path8.join)(done, `${sessionId}-${reason}-${Date.now()}.json`);
      try {
        await (0, import_promises10.rename)(src, dest);
      } catch {
        await (0, import_promises10.unlink)(src).catch(() => void 0);
      }
      return dest;
    },
    async sweepAllAtStartup() {
      let names;
      try {
        names = await (0, import_promises10.readdir)(dir());
      } catch {
        return 0;
      }
      const done = (0, import_node_path8.join)(dir(), "done");
      await (0, import_promises10.mkdir)(done, { recursive: true });
      let swept = 0;
      for (const name of names) {
        if (!name.endsWith(ACK_FILENAME_EXTENSION)) continue;
        try {
          await (0, import_promises10.rename)(
            (0, import_node_path8.join)(dir(), name),
            (0, import_node_path8.join)(
              done,
              `${name.slice(0, -ACK_FILENAME_EXTENSION.length)}-startup-${Date.now()}.json`
            )
          );
          swept++;
        } catch {
        }
      }
      return swept;
    },
    async poll(sessionId, deadline, pollMs, requestedAtMs, threadId) {
      const p = path(sessionId);
      let last = { accepted: false, reason: "none" };
      const outcome = await pollUntil(
        async () => {
          last = await verifyAckFile(p, requestedAtMs, threadId);
          return last.accepted ? last : null;
        },
        { timeoutMs: Math.max(0, deadline - Date.now()), pollMs }
      );
      if (outcome.kind === "hit") return outcome.value;
      const final = await verifyAckFile(p, requestedAtMs, threadId);
      return final.accepted ? final : final.reason === "none" ? last : final;
    },
    async consume(sessionId) {
      const src = path(sessionId);
      const done = (0, import_node_path8.join)(dir(), "done");
      try {
        await (0, import_promises10.mkdir)(done, { recursive: true });
        await (0, import_promises10.rename)(src, (0, import_node_path8.join)(done, `${sessionId}-${Date.now()}.json`));
      } catch {
        await (0, import_promises10.unlink)(src).catch(() => void 0);
      }
    }
  };
}
async function requestFromPeer(peerId, threadId, content) {
  const msgId = generateMessageId();
  await writeEnvelope({
    id: msgId,
    from: syntheticSenderId("control-plane-daemon"),
    fromName: "control-plane-daemon",
    to: peerId,
    kind: "ask",
    sentAt: (/* @__PURE__ */ new Date()).toISOString(),
    threadId,
    content
  });
  return msgId;
}
var compactAcks = createAckChannel("compact-ack");
var stopAcks = createAckChannel("stop-ack");
var restartAcks = createAckChannel("restart-ack");
var ALL_ACK_CHANNELS = [compactAcks, stopAcks, restartAcks];

// src/handlers/peer-identity.ts
var import_node_fs3 = require("node:fs");
var import_node_path10 = require("node:path");

// src/hosts/process-inspector.ts
var import_node_fs2 = require("node:fs");
var import_promises11 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path9 = require("node:path");
var DEFAULT_MAX_DEPTH = 8;
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function parsePpidFromStat(stat5) {
  const close = stat5.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat5.slice(close + 1).trim().split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  return Number.isNaN(ppid) ? null : ppid;
}
function sessionIdFromCmdline(cmdline) {
  const idx = cmdline.indexOf("--resume");
  if (idx === -1) return null;
  const rest = cmdline.slice(idx + "--resume".length).trim();
  const token = rest.split(/\s+/)[0] ?? "";
  const match = UUID_RE.exec((0, import_node_path9.basename)(token));
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
      entries = await (0, import_promises11.readdir)(this.procRoot);
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (Number.isNaN(pid) || String(pid) !== entry) continue;
      const comm = await this.readProcFile(pid, "comm");
      if (comm?.trim() !== "claude") continue;
      const stat5 = await this.readProcFile(pid, "stat");
      const ppid = stat5 ? parsePpidFromStat(stat5) : null;
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
        await (0, import_promises11.access)(candidate, import_node_fs2.constants.X_OK);
        return candidate;
      } catch {
      }
    }
    return null;
  }
  async readProcCwd(pid) {
    try {
      return await (0, import_promises11.readlink)((0, import_node_path9.join)(this.procRoot, String(pid), "cwd"));
    } catch {
      return null;
    }
  }
  async ancestorsOf(pid, maxDepth = DEFAULT_MAX_DEPTH) {
    const chain = [];
    let current = pid;
    for (let i = 0; i < maxDepth; i++) {
      const stat5 = await this.readProcFile(current, "stat");
      if (!stat5) break;
      const ppid = parsePpidFromStat(stat5);
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
      const raw = await (0, import_promises11.readFile)((0, import_node_path9.join)(this.sessionsDir, `${pid}.json`), "utf-8");
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
      return await (0, import_promises11.readFile)((0, import_node_path9.join)(this.procRoot, String(pid), name), "utf-8");
    } catch {
      return null;
    }
  }
};
function defaultProcessInspector() {
  return new LinuxProcessInspector();
}

// src/handlers/peer-identity.ts
function bridgeIdOf(record) {
  return record.observed.sessionId ?? record.handle;
}
var IDENTITY_MEASURE_TIMEOUT_MS = 5e3;
var IDENTITY_POLL_MS = 150;
function pidExists(pid, procRoot) {
  return (0, import_node_fs3.existsSync)((0, import_node_path10.join)(procRoot, String(pid)));
}
async function probeOnce(panePid, inspector) {
  const claudes = await inspector.listClaudePeers().catch(() => []);
  let sawOurs = false;
  for (const proc of claudes) {
    if (proc.pid !== panePid) {
      const chain = [proc.ppid, ...await inspector.ancestorsOf(proc.pid).catch(() => [])];
      if (!chain.includes(panePid)) continue;
    }
    sawOurs = true;
    if (proc.sessionId && proc.sessionIdSource !== "none") {
      return {
        sessionId: proc.sessionId,
        source: proc.sessionIdSource,
        pid: proc.pid,
        measuredAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
  }
  return { kind: sawOurs ? "no-session-id" : "no-claude-under-pane" };
}
async function measureIdentity(panePid, opts = {}) {
  const inspector = opts.inspector ?? defaultProcessInspector();
  const timeoutMs = opts.timeoutMs ?? IDENTITY_MEASURE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? IDENTITY_POLL_MS;
  const procRoot = opts.procRoot ?? "/proc";
  if (!pidExists(panePid, procRoot)) {
    return { kind: "unknown", reason: "pane-pid-gone", waitedMs: 0, attempts: 0 };
  }
  let lastReason = "no-claude-under-pane";
  const outcome = await pollUntil(
    async () => {
      const probe = await probeOnce(panePid, inspector);
      if ("sessionId" in probe) return probe;
      lastReason = probe.kind;
      return null;
    },
    {
      timeoutMs,
      pollMs,
      // Stop the moment the pane process goes: whatever we were waiting for is
      // not coming, and continuing would report a timeout for a death.
      abort: () => pidExists(panePid, procRoot) ? { aborted: false } : { aborted: true, reason: "pane-pid-gone" }
    }
  );
  if (outcome.kind === "hit") {
    return {
      kind: "measured",
      measurement: outcome.value,
      waitedMs: outcome.waitedMs,
      attempts: outcome.attempts
    };
  }
  return {
    kind: "unknown",
    reason: outcome.kind === "aborted" ? "pane-pid-gone" : lastReason,
    waitedMs: outcome.waitedMs,
    attempts: outcome.attempts
  };
}

// src/handlers/peer-compact.ts
var DEFAULT_ANCHOR_TIMEOUT_MS = 3e5;
var DEFAULT_ACK_POLL_MS = 500;
var PeerCompactArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  anchorTimeoutMs: external_exports.number().int().positive().max(3e5).optional(),
  ackPollMs: external_exports.number().int().positive().max(1e4).optional(),
  /** Skip the anchor request → treat the ack file as pre-existing. */
  skipAnchorRequest: external_exports.boolean().default(false),
  /**
   * How long to watch the peer's transcript for the compact to actually run.
   *
   * A parameter, not a constant, because the two honest measurements are
   * 122 s and 130 s on peers around 760k tokens, and the fleet has peers at
   * 846k. A number tuned to today's largest peer is a number that starts
   * lying the day somebody grows past it.
   */
  verifyTimeoutMs: external_exports.number().int().positive().max(6e5).optional(),
  reason: external_exports.string().optional()
}).strict();
async function sweepAllAcksAtStartup() {
  let swept = 0;
  for (const channel of ALL_ACK_CHANNELS) swept += await channel.sweepAllAtStartup();
  return swept;
}
async function writeAnchorRequestMsg(peerId, threadId) {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Compact anchor requested by the control plane. Write your compact anchor, then",
      "write ~/.claude-bridge/control/compact-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}", "anchor": "<where you put it>"}`,
      "",
      "The daemon injects `/compact` only after that file appears, so nothing is",
      "compacted without a durable anchor behind it.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works \u2014 it is accepted on freshness alone \u2014 but two",
      "compacts racing on one peer can only be told apart by the thread."
    ].join("\n")
  );
}
function callerTeamOf2(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}
async function handlePeerCompact(req, ctx) {
  const parsed = PeerCompactArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf2(req, ctx));
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
  const handle = found.handle;
  const record = ctx.state.peers[handle];
  if (!record) {
    return errResult(req.id, req.tool, "peer_gone", "Peer disappeared before compact started", {
      handle
    });
  }
  const bridgeId = bridgeIdOf(record);
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
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
  const threadId = `compact:${bridgeId}:${Date.now().toString(36)}`;
  await (0, import_promises12.mkdir)(compactAcks.dir(), { recursive: true });
  const requestedAtMs = Date.now();
  let anchorMsgId = null;
  let sweptStale = null;
  if (!args.skipAnchorRequest) {
    sweptStale = await compactAcks.sweepStale(bridgeId, "stale");
    if (sweptStale) {
      await writeEvent({
        event: "peer_compact_stale_ack_swept",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle,
          movedTo: sweptStale,
          note: "An ack was already on disk before this request. It answered something else \u2014 v0.11.2 and earlier would have injected /compact over it."
        }
      });
    }
    try {
      anchorMsgId = await writeAnchorRequestMsg(bridgeId, threadId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { handle, stage: "anchor_request", err: msg }
      });
      return errResult(req.id, req.tool, "anchor_request_write_failed", msg, { handle });
    }
    await writeEvent({
      event: "peer_compact_anchor_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, threadId, anchorMsgId, timeoutMs: anchorTimeoutMs }
    });
  }
  const deadline = Date.now() + anchorTimeoutMs;
  const ackFloorMs = args.skipAnchorRequest ? requestedAtMs - anchorTimeoutMs : requestedAtMs;
  const verdict = await compactAcks.poll(bridgeId, deadline, ackPollMs, ackFloorMs, threadId);
  if (!verdict.accepted) {
    await writeEvent({
      event: "peer_compact_anchor_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        threadId,
        timeoutMs: anchorTimeoutMs,
        // WHY there was no usable ack, not just that there wasn't one. "An ack
        // was there and it was not yours" and "nobody answered" call for
        // different next steps, and for two days the tool reported only the
        // second while the first was happening.
        ackVerdict: verdict.reason,
        ackWrittenAt: verdict.writtenAt ?? null,
        ackThreadId: verdict.ackThreadId ?? null
      }
    });
    const why = verdict.reason === "too_old" ? `an ack exists but predates this request (written ${verdict.writtenAt}) \u2014 it answers something else` : verdict.reason === "wrong_thread" ? `an ack exists but belongs to thread '${verdict.ackThreadId}', not '${threadId}' \u2014 another compact is running on this peer` : `no ack appeared within ${anchorTimeoutMs}ms`;
    return errResult(
      req.id,
      req.tool,
      "anchor_timeout",
      `Peer '${handle}' was not compacted: ${why}. Nothing was injected.`,
      {
        handle,
        threadId,
        ackVerdict: verdict.reason,
        ackWrittenAt: verdict.writtenAt ?? null,
        ackThreadId: verdict.ackThreadId ?? null
      }
    );
  }
  const snapshot = await readPeerContext(bridgeId);
  const contextPercentBefore = snapshot.usedPercentage;
  const raceRisk = contextPercentBefore !== null && contextPercentBefore >= COMPACT_RACE_PERCENT ? {
    level: "compact_race_risk",
    percentUsed: contextPercentBefore,
    note: `Peer is at ${contextPercentBefore}% context. Claude Code may autocompact on its own before this /compact runs, which compresses the same context twice.`
  } : null;
  const transcriptPath = snapshot.transcriptPath;
  await writeEvent({
    event: "peer_compact_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      handle,
      sessionKey,
      threadId,
      injectedKeys: "[daemon] /compact",
      contextPercentBefore,
      raceRisk: raceRisk?.level ?? null,
      transcriptPath
    }
  });
  const fromOffset = transcriptPath ? await markTranscript(transcriptPath) : 0;
  try {
    await sendKeys(sessionKey, "/compact");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_compact_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, stage: "send_keys", err: msg }
    });
    return errResult(req.id, req.tool, "send_keys_failed", msg, { handle, sessionKey });
  }
  await compactAcks.consume(bridgeId);
  const common = { handle, sessionKey, threadId, anchorMsgId, contextPercentBefore, raceRisk };
  if (!transcriptPath) {
    await writeEvent({
      event: "peer_compact_unverified",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        ...common,
        why: "no statusLine capture for this peer, so its transcript path is unknown",
        setupPointer: "docs/SETUP-LIVE-DATA.md"
      }
    });
    return okResult(req.id, req.tool, {
      ...common,
      verified: false,
      outcome: "unverifiable",
      note: "Keys were delivered to the input line, but this peer has no statusLine capture, so the daemon cannot read its transcript to confirm the compact ran. See docs/SETUP-LIVE-DATA.md."
    });
  }
  const watch = await watchForCompact({
    transcriptPath,
    fromOffset,
    payload: "/compact",
    timeoutMs: args.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  });
  if (watch.kind === "executed") {
    if (watch.preemptedByAuto) {
      await writeEvent({
        event: "peer_compact_preempted_by_auto",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          ...common,
          auto: watch.preemptedByAuto,
          ours: { at: watch.at, preTokens: watch.preTokens, postTokens: watch.postTokens },
          queuedAt: watch.queuedAt,
          note: "Claude Code autocompacted before our /compact was dequeued, so the peer was compressed twice \u2014 the second time on an already-compacted context. This is the 2026-08-09 incident."
        }
      });
    }
    await writeEvent({
      event: "peer_compacted",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        ...common,
        reason: args.reason ?? null,
        compactedAt: watch.at,
        preTokens: watch.preTokens,
        postTokens: watch.postTokens,
        queuedAt: watch.queuedAt
      }
    });
    await publishLifecycleEvent({
      event: "peer_compacted",
      handle,
      sessionKey,
      details: { threadId, reason: args.reason ?? null, compactedAt: watch.at }
    });
    const wakeLine = wakeAfterCompactLine();
    try {
      await sendKeys(sessionKey, wakeLine);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeEvent({
        event: "peer_compact_wake_failed",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { ...common, err: msg }
      });
      return okResult(req.id, req.tool, {
        ...common,
        verified: true,
        outcome: "compacted",
        compactedAt: watch.at,
        preTokens: watch.preTokens,
        postTokens: watch.postTokens,
        queuedAt: watch.queuedAt,
        preemptedByAuto: watch.preemptedByAuto,
        woken: false,
        wakeError: msg
      });
    }
    return okResult(req.id, req.tool, {
      ...common,
      verified: true,
      outcome: "compacted",
      compactedAt: watch.at,
      preTokens: watch.preTokens,
      postTokens: watch.postTokens,
      queuedAt: watch.queuedAt,
      preemptedByAuto: watch.preemptedByAuto,
      woken: true
    });
  }
  await writeEvent({
    event: "peer_compact_unresolved",
    level: watch.kind === "silent" ? "warn" : "error",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: { ...common, watch }
  });
  if (watch.kind === "queued-unresolved") {
    return errResult(
      req.id,
      req.tool,
      "compact_queued",
      `Peer '${handle}' was BUSY: Claude Code queued the /compact at ${watch.queuedAt} instead of running it, and it had not run ${watch.waitedMs} ms later. It cannot be taken back out of the queue \u2014 it WILL run, at a moment nobody chose, against whatever context exists then. Watch the peer or re-check with peer_compact once it is idle.`,
      { ...common, queuedAt: watch.queuedAt, waitedMs: watch.waitedMs }
    );
  }
  if (watch.kind === "preempted-unresolved") {
    return errResult(
      req.id,
      req.tool,
      "compact_preempted_by_auto",
      `Claude Code autocompacted peer '${handle}' by itself at ${watch.auto.at} (${watch.auto.preTokens} \u2192 ${watch.auto.postTokens} tokens) and OUR /compact has still not run. When it does it will compress an already-compacted context. This is the 2026-08-09 incident, caught in flight.`,
      { ...common, auto: watch.auto, queuedAt: watch.queuedAt, waitedMs: watch.waitedMs }
    );
  }
  return errResult(
    req.id,
    req.tool,
    "compact_not_observed",
    `Keys reached the input line of peer '${handle}', but its transcript shows no compact and no queued command after ${watch.waitedMs} ms. Nothing is known to have happened \u2014 do not assume it did.`,
    { ...common, waitedMs: watch.waitedMs }
  );
}
function wakeAfterCompactLine() {
  return "[daemon] Compact complete \u2014 re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever requested the compact.";
}

// src/handlers/peer-restart.ts
var import_node_fs5 = require("node:fs");
var import_promises14 = require("node:fs/promises");
var import_node_path12 = require("node:path");

// src/handlers/peer-spawn.ts
var import_node_fs4 = require("node:fs");
var import_node_path11 = require("node:path");

// src/handlers/fork-guard.ts
async function forkGuard(state, driver, opts) {
  const record = state.peers[opts.handle];
  if (record && (record.observed.status === "live" || record.observed.status === "starting" || record.observed.status === "restarting")) {
    return {
      reason: "state_live",
      details: {
        handle: opts.handle,
        recordedStatus: record.observed.status,
        tmuxTarget: record.observed.tmuxTarget
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

// src/handlers/peer-spawn.ts
var PeerSpawnArgsSchema = external_exports.object({
  handle: external_exports.string().min(1).describe(
    "Registry key for this peer \u2014 the name the control plane will know it by. Renamed from `sessionId` in v0.11.21: a peer that has not booted has no session id, so this was never one. Pass a UUID only when resuming that exact transcript; otherwise any stable name."
  ),
  displayName: external_exports.string().min(1).describe("Human-visible peer name (also becomes the tmux session name)"),
  cwd: external_exports.string().min(1).describe("Working directory the peer should start in"),
  command: external_exports.string().min(1).describe("Absolute path to `claude` (or another executable for tests)"),
  args: external_exports.array(external_exports.string()).default([]),
  resume: external_exports.boolean().default(false),
  /**
   * WHICH transcript to resume, when it is not the same string as the key.
   *
   * `handle` above is exactly that — the registry key, chosen before the peer
   * existed (see peer-identity.ts). Until v0.11.18 it was also handed to
   * `--resume`, and for a handle-keyed peer that is a string no transcript is
   * named after: `isResumableSessionId("tst-c")` is false, so `resume` came
   * out false and the peer was relaunched EMPTY. A new session under the old
   * name, reported as a successful restart — the quietest way to lose a
   * context there is, because the pid is fresh, the window is right and the
   * name matches.
   *
   * So the identity travels separately from the handle here too. Omitted
   * means "the handle is also the identity", which is true for every adopted
   * peer and was true for 24 of the 25 records on the fleet the day this was
   * measured. It stops being true the moment `team_layout` names a peer.
   */
  resumeSessionId: external_exports.string().min(1).optional(),
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
  extraEnv: external_exports.record(external_exports.string()).default({}).describe("Fully-formed env overrides (bypass whitelist for these names)"),
  team: external_exports.string().optional().describe(
    "Team this peer belongs to. Also decides the tmux window label: a displayName of `mic-tester` in team `mic` labels the window `tester`."
  ),
  label: external_exports.string().min(1).optional().describe(
    "Explicit window label, overriding the one derived from displayName + team. This is how an operator's `control_config set label=\u2026` survives a restart."
  ),
  /**
   * When `envBase` was sampled — or `null` for "carried, and we do not know".
   *
   * Three states, and the difference matters:
   *   absent  — this is a fresh harvest, stamp it with now
   *   string  — carried from a record that knew when it was sampled, keep that
   *   null    — carried from a record that did not know; keep not knowing
   *
   * v0.11.0 had only the first behaviour, so every `peer_restart` stamped
   * `harvestedAt` with the restart time over values that had been sampled days
   * earlier. Measured on 2026-08-06: all 22 rolled peers claimed a harvest at
   * 17:06–17:09 for an environment taken at adoption on 08-05. That is the
   * defect this whole release exists to prevent, committed by the field
   * written to prevent it.
   */
  envHarvestedAt: external_exports.string().nullable().optional()
}).strict();
function findTranscriptElsewhere(sessionId, cwd) {
  try {
    const here = (0, import_node_path11.dirname)(sessionFile(cwd, sessionId));
    for (const dir of (0, import_node_fs4.readdirSync)(projectsRoot())) {
      const candidate = (0, import_node_path11.join)(projectsRoot(), dir, `${sessionId}.jsonl`);
      if ((0, import_node_path11.basename)((0, import_node_path11.join)(projectsRoot(), dir)) === (0, import_node_path11.basename)(here)) continue;
      if ((0, import_node_fs4.existsSync)(candidate)) return candidate;
    }
  } catch {
  }
  return null;
}
function windowLabelFor(displayName, team) {
  if (!team) return displayName;
  const prefix = `${team}-`;
  if (!displayName.startsWith(prefix)) return displayName;
  const short = displayName.slice(prefix.length);
  return short.length > 0 ? short : displayName;
}
async function handlePeerSpawn(req, ctx) {
  const parsed = PeerSpawnArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const sessionKey = args.displayName;
  const plannedTarget = canonicalHostTarget(sessionKey);
  const hit = await forkGuard(ctx.state, ctx.hostDriver, {
    handle: args.handle,
    sessionKey
  });
  if (hit) {
    await writeEvent({
      event: "peer_spawn_rejected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: args.handle, sessionKey, ...hit.details, reason: hit.reason }
    });
    return errResult(
      req.id,
      req.tool,
      "session_already_live",
      `Refusing to spawn \u2014 ${hit.reason === "state_live" ? "daemon state" : "host driver"} still holds sessionId '${args.handle}'`,
      { handle: args.handle, ...hit.details }
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
  const isClaude = args.command.split("/").pop() === "claude";
  const resumeTarget = args.resumeSessionId ?? args.handle;
  if (args.resume) {
    const transcript = sessionFile(args.cwd, resumeTarget);
    if (isClaude && isResumableSessionId(resumeTarget) && !(0, import_node_fs4.existsSync)(transcript)) {
      const elsewhere = findTranscriptElsewhere(resumeTarget, args.cwd);
      await writeEvent({
        event: "peer_spawn_refused",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: args.handle,
          resumeTarget,
          reason: "resume_transcript_missing",
          cwd: args.cwd,
          transcript,
          elsewhere
        }
      });
      return errResult(
        req.id,
        req.tool,
        "resume_transcript_missing",
        elsewhere ? `There is no transcript for ${resumeTarget} under cwd '${args.cwd}' (looked for ${transcript}) \u2014 but one exists at ${elsewhere}. Claude Code finds transcripts by working directory, so this peer would start, fail to find its own history and exit. Spawn it in the directory its transcript belongs to.` : `There is no transcript for ${resumeTarget} anywhere under ~/.claude/projects (looked for ${transcript}). \`--resume\` would print "No conversation found" and exit immediately. Either the session id is wrong, or that session never held a conversation \u2014 a session file is written at boot, a transcript only once something is said.`,
        {
          handle: args.handle,
          resumeTarget,
          cwd: args.cwd,
          transcript,
          foundElsewhere: elsewhere
        }
      );
    }
    spawnArgs.push("--resume", resumeTarget);
  }
  if (args.model) {
    spawnArgs.push("--model", args.model);
  }
  const hostDriverName = ctx.hostDriver.name;
  const existingRestartRequest = ctx.state.peers[args.handle]?.observed.restartRequest ?? null;
  await applyStateChange(ctx.state, (draft) => {
    draft.peers[args.handle] = {
      handle: args.handle,
      desired: {
        ...args.team ? { team: args.team } : {},
        // The short form, stored once rather than recomputed by every caller
        // that paints a window. Until v0.11.0 there was no field for it, so
        // `windowLabelFor` was called at each site and the ones that forgot
        // painted the FQN.
        label: args.label ?? windowLabelFor(args.displayName, args.team),
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
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null
      },
      observed: {
        name: args.displayName,
        hostDriver: hostDriverName,
        tmuxTarget: plannedTarget,
        pid: null,
        status: "starting",
        // `harvestEnv`, not `sanitizeEnv`: `env` above is what this peer starts
        // with, but this is the copy that PERSISTS across restarts, so the
        // pane-scoped vars have to go — they describe a pane that will not be
        // the same one next time.
        ...args.envBase ? {
          spawnEnv: harvestEnv(args.envBase),
          // Only stamp what we actually sampled. `envHarvestedAt` absent
          // means a fresh harvest; present (string or null) means the caller
          // carried these values and already knows their provenance — or
          // knows that it does not.
          ...args.envHarvestedAt === void 0 ? { harvestedAt: (/* @__PURE__ */ new Date()).toISOString() } : args.envHarvestedAt !== null ? { harvestedAt: args.envHarvestedAt } : {}
        } : {},
        model: args.model ?? null,
        // A restart that is UNDERWAY is not ours to erase (v0.11.18).
        //
        // This write replaces the record wholesale, which is right for a spawn:
        // there was no peer, so there is nothing to preserve. During a RESTART
        // there is — the marker `peer_restart` wrote before calling us, and its
        // whole reason to exist is the window we are standing in. Abandoned
        // here, the restart may leave a process no record names; a marker
        // clobbered by the spawn would go missing in exactly the phase it was
        // put there for.
        ...existingRestartRequest ? { restartRequest: existingRestartRequest } : {},
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
  });
  try {
    const record = await ctx.hostDriver.spawn({
      sessionKey,
      ...args.inSession ? { inSession: args.inSession } : {},
      // Name the window after the peer. tmux otherwise names it after the
      // command, so every window read `claude`.
      // The same value the record stores, not a second derivation of it.
      // Computing it twice is how the record and the window get to disagree.
      windowName: args.label ?? windowLabelFor(args.displayName, args.team),
      cwd: args.cwd,
      command: args.command,
      args: spawnArgs,
      env
    });
    const canonicalKey = record.sessionKey;
    if (record.probe?.kind === "pid" && ctx.hostDriver.probePane) {
      await new Promise((r) => setTimeout(r, ctx.spawnConfirmMs ?? 500));
      const again = await ctx.hostDriver.probePane(canonicalKey);
      if (again.kind === "dead" || again.kind === "no-such-target") {
        record.probe = again.kind === "dead" ? again : record.probe;
        record.alive = false;
        if (again.kind === "dead") record.pid = again.pid;
      }
    }
    if (record.probe?.kind === "dead") {
      const { exitStatus } = record.probe;
      const archivePath = await ctx.hostDriver.archivePane?.(canonicalKey, `spawn produced a process that exited ${exitStatus ?? "?"}`).catch(() => null) ?? null;
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[args.handle];
      });
      if (archivePath) await ctx.hostDriver.kill(canonicalKey).catch(() => void 0);
      await writeEvent({
        event: "peer_spawn_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: args.handle,
          sessionKey: canonicalKey,
          reason: "process_exited_after_spawn",
          exitStatus,
          archivePath,
          paneKept: archivePath === null,
          cwd: args.cwd,
          command: args.command
        }
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_process_exited",
        `The command started and exited${exitStatus === null ? "" : ` with status ${exitStatus}`}. ${archivePath ? `What the pane was showing is saved at ${archivePath}.` : `The pane could NOT be archived, so it was left standing \u2014 read it with \`tmux capture-pane -p -t ${canonicalKey}\` before removing it.`}`,
        {
          handle: args.handle,
          sessionKey: canonicalKey,
          exitStatus,
          archivePath,
          probe: record.probe,
          cwd: args.cwd,
          command: args.command
        }
      );
    }
    if (record.probe?.kind === "unavailable") {
      await applyStateChange(ctx.state, (draft) => {
        const rec = draft.peers[args.handle];
        if (!rec) return;
        rec.observed.status = "unknown";
        rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      });
      await writeEvent({
        event: "peer_spawn_unverified",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: args.handle,
          sessionKey: canonicalKey,
          reason: "pane_pid_unavailable",
          hostSaid: record.probe.raw,
          attempts: record.probe.attempts,
          cwd: args.cwd,
          command: args.command
        }
      });
      return errResult(
        req.id,
        req.tool,
        "spawn_unverified",
        `The session was created, but whether anything is running in it could not be determined after ${record.probe.attempts} attempts. Nothing was destroyed: inspect the pane with \`tmux capture-pane -p -t ${canonicalKey}\`, then either \`team_reconcile\` or \`peer_stop\`. The host said: ${record.probe.raw}`,
        {
          handle: args.handle,
          sessionKey: canonicalKey,
          probe: record.probe,
          cwd: args.cwd,
          command: args.command
        }
      );
    }
    if (!record.alive || record.pid === null) {
      await applyStateChange(ctx.state, (draft) => {
        delete draft.peers[args.handle];
      });
      await ctx.hostDriver.kill(canonicalKey).catch(() => void 0);
      await writeEvent({
        event: "peer_spawn_failed",
        level: "error",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: args.handle,
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
        `The session was created and the host reports no such target \u2014 the command exited immediately. Host said: ${record.probe?.kind === "no-such-target" ? record.probe.raw : "(driver reported not-alive without detail)"}`,
        {
          handle: args.handle,
          sessionKey: canonicalKey,
          cwd: args.cwd,
          command: args.command
        }
      );
    }
    const identity = isClaude ? await measureIdentity(record.pid, {
      ...ctx.identityTimeoutMs !== void 0 ? { timeoutMs: ctx.identityTimeoutMs } : {},
      ...ctx.processInspector ? { inspector: ctx.processInspector } : {},
      ...ctx.procRoot ? { procRoot: ctx.procRoot } : {}
    }) : { kind: "unknown", reason: "not-a-claude-peer", waitedMs: 0, attempts: 0 };
    const measured = identity.kind === "measured" ? identity.measurement : null;
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[args.handle];
      if (!rec) return;
      rec.observed.pid = record.pid;
      rec.observed.status = "live";
      rec.observed.tmuxTarget = canonicalKey;
      rec.observed.sessionId = measured?.sessionId ?? null;
      rec.observed.identity = measured ? "measured" : "unknown";
      rec.observed.identityAt = measured?.measuredAt ?? null;
      rec.observed.identitySource = measured?.source ?? null;
      rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
    });
    await writeEvent({
      event: measured ? "peer_identity_measured" : "peer_identity_unmeasured",
      ...measured ? {} : { level: "warn" },
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: args.handle,
        sessionKey: canonicalKey,
        pid: record.pid,
        measuredSessionId: measured?.sessionId ?? null,
        source: measured?.source ?? null,
        // The MEASURED wait, not the budget.
        waitedMs: identity.waitedMs,
        attempts: identity.attempts,
        ...identity.kind === "unknown" ? {
          reason: identity.reason,
          note: "The peer is RUNNING; only its identity is unknown. team_reconcile can measure it later."
        } : {}
      }
    });
    await writeEvent({
      event: "peer_started",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: args.handle,
        sessionKey: canonicalKey,
        rawSessionKey: sessionKey !== canonicalKey ? sessionKey : void 0,
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        // WHAT was resumed, not just whether. A restart that resumed the wrong
        // string is indistinguishable from one that resumed nothing unless the
        // audit trail says which id went on the command line.
        resumedSessionId: args.resume ? resumeTarget : null,
        model: args.model ?? null,
        accountProfile: args.accountProfile ?? null
      }
    });
    await publishLifecycleEvent({
      event: "peer_started",
      handle: args.handle,
      sessionKey: canonicalKey,
      details: {
        pid: record.pid,
        hostDriver: hostDriverName,
        resume: args.resume,
        model: args.model ?? null
      }
    });
    return okResult(req.id, req.tool, {
      // The handle the caller chose — the registry key, and how you address
      // this peer. v0.11.16 left the name alone and said "the rename to
      // `handle` is its own item"; R3 is that item, so the word now matches
      // what the value has always been.
      //
      // `measuredSessionId` below keeps its longer name deliberately. It is a
      // genuine session id and could be called `sessionId` now that the word is
      // free — but a caller reading `sessionId` off this result would silently
      // get a different value than before, which is the one kind of breakage a
      // rename must not produce.
      handle: args.handle,
      sessionKey: canonicalKey,
      pid: record.pid,
      hostDriver: hostDriverName,
      // TOP LEVEL on purpose. A caller must not have to dig for the difference
      // between "we know who this is" and "something is running in there".
      identity: measured ? "measured" : "unknown",
      measuredSessionId: measured?.sessionId ?? null,
      identityWaitedMs: identity.waitedMs,
      resumedSessionId: args.resume ? resumeTarget : null,
      ...measured ? {} : {
        identityNote: "The peer is running, but its Claude session id could not be read within the window. This is NOT a failed spawn. Cross-referencing it against peer_list will not work until team_reconcile measures it."
      }
    });
  } catch (e) {
    await applyStateChange(ctx.state, (draft) => {
      delete draft.peers[args.handle];
    });
    const message = e instanceof Error ? e.message : String(e);
    await writeEvent({
      event: "peer_spawn_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: args.handle, sessionKey, err: message }
    });
    return errResult(req.id, req.tool, "spawn_failed", message, {
      handle: args.handle,
      sessionKey
    });
  }
}

// src/handlers/peer-stop.ts
var import_promises13 = require("node:fs/promises");

// src/handlers/stop-protocol.ts
var DEFAULT_STOP_ACK_TIMEOUT_MS = 12e4;
var DEFAULT_STOP_ACK_POLL_MS = 500;
function stopThreadId(sessionId, now = Date.now()) {
  return `stop:${sessionId}:${now.toString(36)}`;
}
async function requestStop(peerId, threadId, reason) {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Stop requested by the control plane. Park or finish what you are doing, flush your",
      "anchor and memory, then write ~/.claude-bridge/control/stop-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}"}`,
      "",
      "The daemon ends your session only after that file appears. Until then nothing is",
      "killed \u2014 so take the time you need, and do not ack before your work is durable.",
      "",
      "If you do NOT ack, the daemon does not kill you either: the stop is reported as",
      "failed and left for a human. A forced stop is a separate, explicit decision.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works \u2014 it is accepted on freshness alone.",
      reason ? `
Reason given: ${reason}` : ""
    ].join("\n").trimEnd()
  );
}

// src/handlers/peer-stop.ts
var PeerStopArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  reason: external_exports.string().optional(),
  /**
   * Skip the courtesy phase and kill immediately.
   *
   * BREAKING in v0.11.15: this used to be the only behaviour, so every
   * internal caller that wants it now says so explicitly. The default flipped
   * because a human typing `peer_stop` almost always means "wind it down",
   * and the dangerous reading is the one that should need a word.
   */
  force: external_exports.boolean().default(false),
  /**
   * The courtesy already happened somewhere else — skip it, change nothing
   * else. FOR INTERNAL CALLERS.
   *
   * This exists because `force` means two things to the driver, and only one
   * of them belongs to an internal caller. `force` skips the ack wait AND
   * halves the post-kill verify budget (`tmux-driver.ts:571`) — and that
   * verify is what catches a supervised process respawning behind us. An
   * orchestrator that has already done the asking wants the first half and
   * must not silently buy the second: a shorter verify makes a false "kill
   * succeeded" more likely, and FORCE SKIPS WAITING, NEVER EVIDENCE.
   *
   * So `team_stop`, `team_layout` and `peer_restart` pin `skipCourtesy: true`
   * and pass `force` through unchanged, which reproduces their v0.11.14
   * behaviour exactly. A human still says `force: true` and gets both.
   */
  skipCourtesy: external_exports.boolean().default(false),
  /** How long the peer gets to ack before the stop is reported as failed. */
  ackTimeoutMs: external_exports.number().int().positive().max(6e5).optional(),
  ackPollMs: external_exports.number().int().positive().max(1e4).optional(),
  /**
   * v0.10.1: keep the peer in state.peers with status:"stopped" instead
   * of deleting it. Used by team_stop so that team_layout apply can
   * resume the same handle later. Default false = original delete
   * semantics (backward-compatible with v0.10.0-rc.2 callers).
   */
  keepInState: external_exports.boolean().default(false),
  /**
   * Only meaningful when keepInState:true — sets the resulting
   * PeerRecord.stoppedCleanly.
   *
   * Honoured in FORCE mode only. In the graceful path this handler measures
   * the outcome itself (an ack arrived, or it did not), and a measurement
   * does not take instructions from its caller. Passing it alongside
   * `force:false` is ignored, deliberately: the alternative is a record whose
   * `stoppedCleanly` says whatever the caller hoped for.
   */
  stoppedCleanly: external_exports.boolean().nullable().optional()
}).strict();
function callerTeamOf3(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}
async function runCourtesyPhase(req, ctx, target, args) {
  const { handle, sessionKey, record } = target;
  const alive = record.observed.tmuxTarget ? await ctx.hostDriver.hasSession(sessionKey).catch(() => false) : false;
  if (!alive) return { kind: "no-host" };
  const bridgeId = bridgeIdOf(record);
  const timeoutMs = args.ackTimeoutMs ?? DEFAULT_STOP_ACK_TIMEOUT_MS;
  const pollMs = args.ackPollMs ?? DEFAULT_STOP_ACK_POLL_MS;
  await (0, import_promises13.mkdir)(stopAcks.dir(), { recursive: true });
  const pending = record.observed.stopRequest ?? null;
  const resumed = pending !== null;
  let threadId;
  let requestedAtMs;
  if (pending) {
    threadId = pending.threadId;
    requestedAtMs = Date.parse(pending.requestedAt);
    if (Number.isNaN(requestedAtMs)) requestedAtMs = Date.now() - timeoutMs;
    await writeEvent({
      event: "peer_stop_request_resumed",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle,
        sessionKey,
        threadId,
        originallyRequestedAt: pending.requestedAt,
        note: "A stop was already pending for this peer. Waiting on the same thread \u2014 no second request was written."
      }
    });
  } else {
    const swept = await stopAcks.sweepStale(bridgeId, "stale");
    if (swept) {
      await writeEvent({
        event: "peer_stop_stale_ack_swept",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: { handle, movedTo: swept }
      });
    }
    requestedAtMs = Date.now();
    threadId = stopThreadId(handle, requestedAtMs);
    const msgId = await requestStop(bridgeId, threadId, args.reason ?? null);
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[handle];
      if (rec) {
        rec.observed.status = "stopping";
        rec.observed.stopRequest = {
          threadId,
          msgId,
          requestedAt: new Date(requestedAtMs).toISOString(),
          timeoutMs
        };
        rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    });
    await writeEvent({
      event: "peer_stop_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, threadId, msgId, timeoutMs }
    });
  }
  const startedWaitingAt = Date.now();
  const verdict = await stopAcks.poll(
    bridgeId,
    startedWaitingAt + timeoutMs,
    pollMs,
    requestedAtMs,
    threadId
  );
  const waitedMs = Date.now() - startedWaitingAt;
  if (!verdict.accepted) {
    return {
      kind: "no-ack",
      threadId,
      timeoutMs,
      waitedMs,
      ackVerdict: verdict.reason,
      ackThreadId: verdict.ackThreadId ?? null,
      resumed
    };
  }
  await stopAcks.consume(bridgeId);
  return { kind: "acked", threadId, waitedMs, resumed };
}
async function handlePeerStop(req, ctx) {
  const parsed = PeerStopArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf3(req, ctx));
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
  const handle = found.handle;
  const record = ctx.state.peers[handle];
  if (!record) {
    return okResult(req.id, req.tool, { handle, alreadyGone: true });
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const forceFlag = args.force === true;
  let courtesy = { kind: "skipped" };
  if (!forceFlag && !args.skipCourtesy) {
    courtesy = await runCourtesyPhase(req, ctx, { handle, sessionKey, record }, args);
    if (courtesy.kind === "no-ack") {
      await writeEvent({
        event: "stop_ack_timeout",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle,
          sessionKey,
          threadId: courtesy.threadId,
          timeoutMs: courtesy.timeoutMs,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          ackThreadId: courtesy.ackThreadId,
          resumed: courtesy.resumed
        }
      });
      const why = courtesy.ackVerdict === "wrong_thread" ? `an ack exists but answers thread '${courtesy.ackThreadId}', not '${courtesy.threadId}' \u2014 another stop is running on this peer` : courtesy.ackVerdict === "too_old" ? "an ack exists but predates this request \u2014 it answers something else" : `the peer did not ack within ${courtesy.timeoutMs}ms`;
      return errResult(
        req.id,
        req.tool,
        "stop_ack_timeout",
        `Peer '${handle}' is STILL RUNNING and nothing was killed: ${why}. The request stands \u2014 call peer_stop again to keep waiting on the same thread (a late ack still counts), or peer_stop with force:true to end the session now and lose whatever the peer had not written down.`,
        {
          handle,
          sessionKey,
          stopped: false,
          processLeftRunning: true,
          threadId: courtesy.threadId,
          waitedMs: courtesy.waitedMs,
          ackVerdict: courtesy.ackVerdict,
          retryIsIdempotent: true
        }
      );
    }
  }
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (rec) {
      rec.observed.status = "stopping";
      rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
  });
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
        details: { handle, sessionKey, err: msg }
      });
      return errResult(req.id, req.tool, "supervisor_respawn", msg, { handle, sessionKey });
    }
    await writeEvent({
      event: "peer_stop_failed",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, sessionKey, err: msg }
    });
    return errResult(req.id, req.tool, "host_kill_failed", msg, { handle, sessionKey });
  }
  const keepInState = args.keepInState;
  const measuredCleanly = courtesy.kind === "acked" ? true : courtesy.kind === "no-host" ? null : void 0;
  const stoppedCleanly = keepInState ? measuredCleanly ?? args.stoppedCleanly ?? null : measuredCleanly ?? void 0;
  await applyStateChange(ctx.state, (draft) => {
    if (keepInState) {
      const rec = draft.peers[handle];
      if (rec) {
        rec.observed.status = "stopped";
        rec.observed.stoppedCleanly = stoppedCleanly ?? null;
        rec.observed.pid = null;
        rec.observed.stopRequest = null;
        rec.observed.restartRequest = null;
        rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    } else {
      delete draft.peers[handle];
    }
  });
  const mode = courtesy.kind === "acked" ? "graceful" : courtesy.kind === "no-host" ? "already-gone" : "forced";
  const ackWaitedMs = courtesy.kind === "acked" ? courtesy.waitedMs : null;
  const threadId = courtesy.kind === "acked" ? courtesy.threadId : null;
  const details = {
    handle,
    sessionKey,
    reason: args.reason ?? null,
    force: forceFlag,
    keepInState,
    stoppedCleanly,
    mode,
    ackWaitedMs,
    threadId
  };
  await writeEvent({
    event: "peer_stopped",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details
  });
  await publishLifecycleEvent({
    event: "peer_stopped",
    handle,
    sessionKey,
    details: { reason: args.reason ?? null, force: forceFlag, keepInState, stoppedCleanly, mode }
  });
  return okResult(req.id, req.tool, {
    handle,
    sessionKey,
    stopped: true,
    mode,
    force: forceFlag,
    keepInState,
    stoppedCleanly,
    ackWaitedMs,
    threadId
  });
}

// src/handlers/restart-protocol.ts
var DEFAULT_RESTART_READY_TIMEOUT_MS = 12e4;
var DEFAULT_RESTART_READY_POLL_MS = 500;
function restartThreadId(sessionId, now = Date.now()) {
  return `restart:${sessionId}:${now.toString(36)}`;
}
async function requestRestartReady(peerId, threadId, reason) {
  return requestFromPeer(
    peerId,
    threadId,
    [
      "Restart requested by the control plane. You are COMING BACK \u2014 your session is",
      "resumed with its transcript, so park your work where you will find it again",
      "rather than winding it down.",
      "",
      "Finish or park the current turn, flush your anchor and memory, then write",
      "~/.claude-bridge/control/restart-ack/<sessionId>.json containing:",
      "",
      `    {"threadId": "${threadId}"}`,
      "",
      "Nothing is stopped until that file appears. If you do NOT ack, nothing is",
      "stopped either: the restart is reported as failed and you keep running,",
      "untouched. So take the time you need \u2014 do not ack before your work is durable.",
      "",
      "The `threadId` matters: an ack that answers a DIFFERENT request is refused.",
      "An empty `touch` still works \u2014 it is accepted on freshness alone.",
      reason ? `
Reason given: ${reason}` : ""
    ].join("\n").trimEnd()
  );
}

// src/handlers/wake.ts
var import_node_crypto5 = require("node:crypto");
var DEFAULT_WAKE_DELAY_MS = 8e3;
var DEFAULT_WAKE_PROMPT = "[daemon] Wake \u2014 you were resumed from a stopped state. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever woke you.";
var RESTART_WAKE_PROMPT = "[daemon] Restart complete \u2014 same session, new process. Re-onboard from your anchor, read your inbox (peer_inbox_read) and report to whoever restarted you.";
function generateMsgId2() {
  const ms = Date.now().toString(36);
  const rand = (0, import_node_crypto5.randomBytes)(4).toString("hex");
  return `${ms}-${rand}`;
}
async function writeWakeMsg(opts, threadId) {
  const msgId = generateMsgId2();
  const dirty = opts.stoppedCleanly === false;
  const restarted = opts.event === "restarted";
  const lines = restarted ? [
    "Your restart is complete \u2014 same session, same transcript, new process.",
    "Re-onboard from your anchor before doing anything else, then report to",
    "whoever restarted you.",
    "",
    `Reason: ${opts.reason}`
  ] : [
    "You were resumed from a stopped state. Re-onboard from your anchor before",
    "doing anything else, then report to whoever woke you.",
    "",
    `Reason: ${opts.reason}`
  ];
  if (dirty) {
    lines.push(
      "",
      restarted ? "\u26A0 This restart was FORCED \u2014 you were not asked to get ready, so whatever you" : "\u26A0 Your previous stop was FORCED \u2014 you did not complete the stop-ack cycle,",
      restarted ? "had not written down at that moment is gone. YOUR ANCHOR MAY BE MID-WRITE OR" : "so your anchor and memory may be incomplete or mid-write. Verify them",
      restarted ? "STALE \u2014 verify it against reality before you build on it." : "before trusting them."
    );
  } else if (opts.stoppedCleanly === true) {
    lines.push(
      "",
      restarted ? "You acknowledged the restart request, so your anchor should be whole." : "Your previous stop completed its ack cycle, so your anchor should be whole."
    );
  }
  await writeEnvelope({
    id: msgId,
    from: syntheticSenderId("control-plane-daemon"),
    fromName: "control-plane-daemon",
    to: opts.bridgeId,
    kind: "ask",
    sentAt: (/* @__PURE__ */ new Date()).toISOString(),
    threadId,
    content: lines.join("\n")
  });
  return msgId;
}
async function wakePeer(req, ctx, opts) {
  const threadId = `wake:${opts.bridgeId}:${Date.now().toString(36)}`;
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
      details: { bridgeId: opts.bridgeId, stage: "inbox_write", err }
    });
    return { bridgeId: opts.bridgeId, wakeMsgId: null, injected: false, error: err };
  }
  const sendKeys = ctx.hostDriver.sendKeys?.bind(ctx.hostDriver);
  if (!sendKeys) {
    await writeEvent({
      event: "peer_wake_not_injected",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        bridgeId: opts.bridgeId,
        wakeMsgId,
        hostDriver: ctx.hostDriver.name,
        note: "driver has no send-keys \u2014 peer stays silent until a turn is triggered by hand"
      }
    });
    return { bridgeId: opts.bridgeId, wakeMsgId, injected: false };
  }
  const delay = opts.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const prompt = opts.wakePrompt ?? DEFAULT_WAKE_PROMPT;
  await writeEvent({
    event: "peer_wake_inject",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      bridgeId: opts.bridgeId,
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
      details: { bridgeId: opts.bridgeId, sessionKey: opts.sessionKey, stage: "send_keys", err }
    });
    return { bridgeId: opts.bridgeId, wakeMsgId, injected: false, error: err };
  }
  await writeEvent({
    event: "peer_woken",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      bridgeId: opts.bridgeId,
      sessionKey: opts.sessionKey,
      threadId,
      wakeMsgId,
      reason: opts.reason,
      stoppedCleanly: opts.stoppedCleanly ?? null,
      wakeKind: opts.event ?? "resumed"
    }
  });
  await publishLifecycleEvent({
    event: "peer_woken",
    handle: opts.bridgeId,
    sessionKey: opts.sessionKey,
    details: { reason: opts.reason, stoppedCleanly: opts.stoppedCleanly ?? null }
  });
  return { bridgeId: opts.bridgeId, wakeMsgId, injected: true };
}

// src/handlers/peer-restart.ts
var PeerRestartArgsSchema = external_exports.object({
  peer: external_exports.string().min(1),
  reason: external_exports.string().optional(),
  /**
   * Skip the asking — both of it: no ready-request, no stop courtesy.
   *
   * FORCE SKIPS WAITING, NEVER EVIDENCE. It does not skip the dead-pane
   * archive, the identity check after the relaunch, or step g) — and step g)
   * is the one that matters most here, because a peer that was never asked to
   * tidy up is the peer most likely to be holding a half-written anchor. It
   * gets told so.
   */
  force: external_exports.boolean().default(false),
  /** How long the peer gets to say it is ready. Ignored when `force`. */
  readyTimeoutMs: external_exports.number().int().positive().max(6e5).optional(),
  readyPollMs: external_exports.number().int().positive().max(1e4).optional(),
  model: external_exports.string().optional(),
  accountProfile: external_exports.string().optional()
}).strict();
var UUID_RE2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isResumableSessionId(sessionId) {
  return UUID_RE2.test(sessionId);
}
async function confirmStillRunning(pid, identity, expectedSessionId, opts = {}) {
  if (pid === null) return { ok: false, reason: "no pid was reported by the spawn" };
  const windowMs = opts.settleMs ?? 2500;
  const procRoot = opts.procRoot ?? "/proc";
  const alive = () => (0, import_node_fs5.existsSync)((0, import_node_path12.join)(procRoot, String(pid)));
  const isClaude = (opts.command ?? "").split("/").pop() === "claude";
  const mustRegister = isClaude && isResumableSessionId(expectedSessionId);
  const registered = identity.actual !== null;
  const pollMs = 100;
  const budget = registered || !mustRegister ? Math.min(windowMs, 400) : windowMs;
  const outcome = await pollUntil(() => null, {
    timeoutMs: budget,
    pollMs,
    abort: () => alive() ? { aborted: false } : { aborted: true, reason: "exited" }
  });
  if (outcome.kind === "aborted" || !alive()) {
    return { ok: false, reason: `pid ${pid} exited ${outcome.waitedMs} ms after starting` };
  }
  if (mustRegister && !registered) {
    return {
      ok: false,
      reason: `pid ${pid} is running but registered no session \u2014 ~/.claude/sessions/${pid}.json never appeared`
    };
  }
  return { ok: true, reason: "alive and registered" };
}
function identityVerdict(intendedSessionId, measuredSessionId) {
  if (intendedSessionId === null || !isResumableSessionId(intendedSessionId)) {
    return { mismatch: false, actual: measuredSessionId };
  }
  if (measuredSessionId === null) return { mismatch: false, actual: null };
  return { mismatch: measuredSessionId !== intendedSessionId, actual: measuredSessionId };
}
function decideResume(record) {
  const handle = record.handle;
  const measured = record.observed.sessionId ?? null;
  const identity = record.observed.identity;
  const canHaveIdentity = (record.desired.command ?? "claude").split("/").pop() === "claude";
  if (isResumableSessionId(handle) && (measured === null || measured === handle)) {
    return { kind: "resume", sessionId: handle, source: "handle" };
  }
  if (identity === "measured" && measured !== null && isResumableSessionId(measured)) {
    return { kind: "resume", sessionId: measured, source: "measured-identity" };
  }
  if (canHaveIdentity && (identity === "unknown" || identity === void 0 && measured === null)) {
    return {
      kind: "refuse",
      why: identity === "unknown" ? "the peer's identity is UNKNOWN \u2014 it is running, but the daemon has not been able to read its session id" : "this record predates identity measurement (v0.11.16) and its key is not a session id"
    };
  }
  return {
    kind: "fresh",
    why: `handle '${handle}' is not a session id and no identity was measured \u2014 the peer starts fresh`
  };
}
async function markNotRunning(ctx, handle) {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec) return;
    rec.observed.status = "unknown";
    rec.observed.pid = null;
    rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
}
function callerTeamOf4(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
}
async function markRestart(ctx, handle, phase, fields) {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec) return;
    rec.observed.restartRequest = { ...fields, phase };
    if (phase === "ready-ack") rec.observed.status = "restarting";
    rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
}
async function clearRestartMark(ctx, handle) {
  await applyStateChange(ctx.state, (draft) => {
    const rec = draft.peers[handle];
    if (!rec?.observed.restartRequest) return;
    rec.observed.restartRequest = null;
    rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
  });
}
async function runReadyPhase(req, ctx, target, args, resumeSessionId) {
  const { handle, sessionKey, record } = target;
  if (args.force) return { kind: "skipped" };
  const alive = record.observed.tmuxTarget ? await ctx.hostDriver.hasSession(sessionKey).catch(() => false) : false;
  if (!alive) return { kind: "no-host" };
  const bridgeId = bridgeIdOf(record);
  const timeoutMs = args.readyTimeoutMs ?? DEFAULT_RESTART_READY_TIMEOUT_MS;
  const pollMs = args.readyPollMs ?? DEFAULT_RESTART_READY_POLL_MS;
  await (0, import_promises14.mkdir)(restartAcks.dir(), { recursive: true });
  const pending = record.observed.restartRequest ?? null;
  const resumable = pending !== null && pending.phase === "ready-ack";
  let threadId;
  let msgId;
  let requestedAtMs;
  if (resumable && pending) {
    threadId = pending.threadId;
    msgId = pending.msgId;
    requestedAtMs = Date.parse(pending.requestedAt);
    await writeEvent({
      event: "peer_restart_ready_resumed",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, threadId, requestedAt: pending.requestedAt, note: "no second request" }
    });
  } else {
    await restartAcks.sweepStale(bridgeId, "pre-request");
    threadId = restartThreadId(bridgeId);
    requestedAtMs = Date.now();
    msgId = await requestRestartReady(bridgeId, threadId, args.reason ?? null);
    await markRestart(ctx, handle, "ready-ack", {
      threadId,
      msgId,
      requestedAt: new Date(requestedAtMs).toISOString(),
      timeoutMs,
      requestId: req.id,
      resumeSessionId
    });
    await writeEvent({
      event: "peer_restart_requested",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle, bridgeId, sessionKey, threadId, msgId, timeoutMs, resumeSessionId }
    });
  }
  const started = Date.now();
  const verdict = await restartAcks.poll(
    bridgeId,
    requestedAtMs + timeoutMs,
    pollMs,
    requestedAtMs,
    threadId
  );
  const waitedMs = Date.now() - started;
  if (verdict.accepted) {
    await restartAcks.consume(bridgeId);
    return { kind: "acked", threadId, msgId, waitedMs, resumed: resumable };
  }
  return {
    kind: "no-ack",
    threadId,
    msgId,
    timeoutMs,
    waitedMs,
    ackVerdict: verdict.reason,
    resumed: resumable
  };
}
async function handlePeerRestart(req, ctx) {
  const parsed = PeerRestartArgsSchema.safeParse(req.args);
  if (!parsed.success) {
    return errResult(req.id, req.tool, "invalid_args", "Schema validation failed", {
      issues: parsed.error.issues
    });
  }
  const args = parsed.data;
  const resolved = resolvePeerRef(ctx.state.peers, args.peer, callerTeamOf4(req, ctx));
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
  const inFlight = record.observed.restartRequest ?? null;
  if (inFlight && inFlight.phase !== "ready-ack") {
    return errResult(
      req.id,
      req.tool,
      "restart_in_progress",
      `A restart of '${record.handle}' is already in its ${inFlight.phase} phase (requested at ${inFlight.requestedAt} by ${inFlight.requestId}). Entering it twice would risk two processes behind one record. Wait for it, or check team_reconcile for a restart_pending drift if the caller is gone.`,
      { handle: record.handle, phase: inFlight.phase, since: inFlight.requestedAt }
    );
  }
  const cwd = record.desired.cwd ?? process.cwd();
  const command = record.desired.command ?? "claude";
  const commandArgs = record.desired.spawnArgs ?? [];
  const missing = [
    record.desired.cwd ? null : "cwd",
    record.desired.command ? null : "command"
  ].filter((f) => f !== null);
  if (missing.length > 0) {
    await writeEvent({
      event: "peer_restart_launch_params_unknown",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        missing,
        fallbackCwd: cwd,
        fallbackCommand: command,
        hint: "Peer record predates launch-parameter persistence (v0.10.3). The restart uses the daemon's cwd and a bare `claude`, which fails on installs where claude is not on the daemon's PATH (nvm). Re-spawn the peer to record its real parameters."
      }
    });
  }
  const resumeDecision = decideResume(record);
  if (resumeDecision.kind === "refuse") {
    await writeEvent({
      event: "peer_restart_refused",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: record.handle, reason: resumeDecision.why }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_unknown",
      `Refusing to restart '${record.handle}': ${resumeDecision.why}. Resuming the handle would relaunch the peer EMPTY and report success; resuming nothing would drop its context on purpose. Neither is this tool's decision to make. Run team_reconcile to measure the identity, then restart. NOTHING WAS TOUCHED \u2014 the peer is still running.`,
      {
        handle: record.handle,
        identity: record.observed.identity ?? null,
        measuredSessionId: record.observed.sessionId ?? null
      }
    );
  }
  const resumeSessionId = resumeDecision.kind === "resume" ? resumeDecision.sessionId : null;
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  let inSession = record.desired.homeSession ?? null;
  if (inSession === null && record.observed.tmuxTarget && parseHostTarget(record.observed.tmuxTarget).kind === "window") {
    const windows = ctx.hostDriver.listWindows ? await ctx.hostDriver.listWindows() : [];
    inSession = windows.find((w) => w.target === record.observed.tmuxTarget)?.session ?? null;
    if (inSession === null) {
      await writeEvent({
        event: "peer_restart_window_home_unknown",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: record.handle,
          tmuxTarget: record.observed.tmuxTarget,
          hint: "The window is not on the host, so its parent session cannot be read. The peer will be relaunched as a session of its own."
        }
      });
    }
  }
  const provenanceDesired = {
    ...record.desired.team !== void 0 ? { team: record.desired.team } : {},
    ...record.desired.label !== void 0 ? { label: record.desired.label } : {},
    ...record.desired.windowIndex !== void 0 ? { windowIndex: record.desired.windowIndex } : {},
    ...inSession ? { homeSession: inSession } : {}
  };
  const provenanceObserved = {
    ...record.observed.adopted !== void 0 ? { adopted: record.observed.adopted } : {},
    ...record.observed.spawnEnv ? { spawnEnv: record.observed.spawnEnv } : {},
    // Carry the ORIGINAL sampling time, not the restart's.
    //
    // `peer_spawn` stamps `harvestedAt` when it is handed an `envBase`, which
    // is right for a first spawn and wrong here: the values being passed in
    // were sampled once, long ago, and a restart only copies them. Letting the
    // spawn re-stamp would date a stale environment to now — inventing a
    // provenance, which is the precise move this release exists to stop.
    ...record.observed.harvestedAt !== void 0 ? { harvestedAt: record.observed.harvestedAt } : {}
  };
  const ready = await runReadyPhase(
    req,
    ctx,
    { handle: record.handle, sessionKey, record },
    args,
    resumeSessionId
  );
  if (ready.kind === "no-ack") {
    await writeEvent({
      event: "peer_restart_ready_timeout",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        threadId: ready.threadId,
        timeoutMs: ready.timeoutMs,
        waitedMs: ready.waitedMs,
        ackVerdict: ready.ackVerdict,
        resumed: ready.resumed
      }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_ready_timeout",
      `Peer '${record.handle}' did not say it was ready within ${ready.timeoutMs} ms (waited ${ready.waitedMs} ms, last ack verdict: ${ready.ackVerdict}). NOTHING WAS STOPPED and nothing was killed \u2014 the peer is running exactly as before. The request stands: call peer_restart again to keep waiting on the same thread (a late ack still counts), or peer_restart with force:true to restart it now and lose whatever it had not written down.`,
      {
        handle: record.handle,
        threadId: ready.threadId,
        waitedMs: ready.waitedMs,
        stillRunning: true
      }
    );
  }
  const readyThreadId = ready.kind === "acked" ? ready.threadId : restartThreadId(record.handle);
  const restartMarkFields = {
    threadId: readyThreadId,
    msgId: ready.kind === "acked" ? ready.msgId : null,
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    timeoutMs: args.readyTimeoutMs ?? DEFAULT_RESTART_READY_TIMEOUT_MS,
    requestId: req.id,
    resumeSessionId
  };
  await markRestart(ctx, record.handle, "stopping", restartMarkFields);
  const stopArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:stop`,
    ts: req.ts,
    tool: "peer_stop",
    args: {
      peer: record.handle,
      reason: args.reason ?? "peer_restart",
      // 🔴 ONE ASK, NOT TWO — corrected by the acceptance run.
      //
      // The design had step c) run the primitive's own courtesy on a short
      // window, so that `stoppedCleanly` stayed a measurement taken by
      // `peer_stop` rather than a claim made here. Measured on a live peer
      // 2026-08-08: the ready-ack took 30 s (a full agent turn — read the
      // inbox, park the work, write the file), and the stop-request that
      // followed asked the SAME peer the SAME question, needing another whole
      // turn. It timed out, and the restart failed on a peer that had done
      // everything right.
      //
      // The estimate was not merely low. The second ask is the wrong SHAPE:
      // what `stoppedCleanly` is supposed to record is "the peer had a chance
      // to save its work before it died", and the ready-ack IS that
      // measurement. A stop-ack would only add "…and it was still ready
      // fifteen seconds later", for the price of doubling the restart.
      //
      // So the measurement moves rather than disappearing: `skipCourtesy`
      // because the asking already happened HERE, and `stoppedCleanly: true`
      // because this handler measured it — the ack file existed, was fresh, and
      // matched the thread. That is not a caller's opinion.
      ...ready.kind === "acked" ? { skipCourtesy: true, stoppedCleanly: true } : {},
      // Keep the record through the stop. The restart mark lives on it, and the
      // mark's whole job is to survive the window where the peer is neither the
      // old process nor the new one.
      keepInState: true,
      force: args.force
    },
    requestedBy: req.requestedBy
  };
  const stopResult = await handlePeerStop(stopArgs, ctx);
  if (stopResult.outcome === "error") {
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_stop_failed",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
        code: stopResult.error?.code ?? null,
        readyAcked: ready.kind === "acked"
      }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_stop_failed",
      `${stopResult.error?.message ?? "peer_stop failed"} \u2014 the restart stopped here, and the peer is still running. Retry, or use force:true.`,
      { stopResult, handle: record.handle, stillRunning: true }
    );
  }
  const stoppedCleanly = stopResult.data?.stoppedCleanly ?? null;
  const spawnArgs = {
    schemaVersion: req.schemaVersion,
    id: `${req.id}:spawn`,
    ts: req.ts,
    tool: "peer_spawn",
    args: {
      handle: record.handle,
      displayName: record.observed.name,
      cwd,
      // The test override stays ahead of the record so the acceptance suite can
      // relaunch something cheaper than a real Claude Code.
      command: process.env["CLAUDE_BRIDGE_TEST_COMMAND"] ?? command,
      args: commandArgs,
      ...inSession ? { inSession } : {},
      // The team, and the label derived from it.
      //
      // Omitted until v0.11.1, and that was not cosmetic: `peer_spawn` names
      // the tmux window from `windowLabelFor(displayName, team)`, so without a
      // team every relaunched window came back wearing the fully qualified
      // name. The v0.10.21 label fix covered `team_layout` and direct spawns
      // and left this path alone, where it sat unnoticed because nothing had
      // restarted through it since — until the v0.11.0 roll renamed 22 windows
      // back in one pass.
      ...record.desired.team !== void 0 ? { team: record.desired.team } : {},
      // An operator's declared label wins over the derived one, or
      // `control_config set label=…` would survive in the record and never
      // reach the window it names.
      ...record.desired.label !== void 0 ? { label: record.desired.label } : {},
      // The peer's own environment. Without it the relaunch inherits the
      // daemon's PATH and comes up unable to find node.
      ...record.observed.spawnEnv ? {
        envBase: record.observed.spawnEnv,
        // Always passed, so the spawn never mistakes a copy for a sample.
        // `null` says "carried, provenance unknown" — which is the honest
        // answer for every record migrated out of v1.
        envHarvestedAt: record.observed.harvestedAt ?? null
      } : {},
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
      // The DECISION from step a), not a re-derivation of it. Handing
      // `record.sessionId` to `--resume` is the defect this release fixes: for a
      // handle-keyed peer that is a string no transcript is named after, so
      // `resume` came out false and the peer came back empty under its own name.
      resume: resumeSessionId !== null,
      ...resumeSessionId !== null ? { resumeSessionId } : {},
      // Intent first, measurement only as a fallback. A peer whose model was
      // switched at runtime has no `desired.model` recording that choice, and
      // relaunching it on the older declared model would be a silent downgrade
      // — so the observation still gets a turn, but never ahead of a stated
      // intent. Ordering is the whole answer here; picking one side is not.
      model: args.model ?? record.desired.model ?? record.observed.model ?? null,
      accountProfile: args.accountProfile ?? record.desired.accountProfile ?? null,
      extraAllowEnv: [],
      extraEnv: {}
    },
    requestedBy: req.requestedBy
  };
  await markRestart(ctx, record.handle, "spawning", restartMarkFields);
  const spawnResult = await handlePeerSpawn(spawnArgs, ctx);
  if (spawnResult.outcome === "error") {
    await applyStateChange(ctx.state, (draft) => {
      draft.peers[record.handle] = {
        ...record,
        // Intent is untouched — the operator still wants this peer, which is
        // exactly why the record survives a failed relaunch. Only the
        // measurement changes, and it changes to "we do not know".
        observed: {
          ...record.observed,
          status: "unknown",
          pid: null,
          // The restart is over — it failed. Leaving the mark would make the
          // next call refuse as `restart_in_progress` and `team_reconcile`
          // report an abandoned restart, for something that finished and said so.
          restartRequest: null,
          lastUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
    });
    await writeEvent({
      event: "peer_restart_record_retained",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: record.handle,
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
  const hasProvenance = Object.keys(provenanceDesired).length > 0 || Object.keys(provenanceObserved).length > 0;
  if (hasProvenance) {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[record.handle];
      if (!rec) return;
      Object.assign(rec.desired, provenanceDesired);
      Object.assign(rec.observed, provenanceObserved);
    });
  }
  await markRestart(ctx, record.handle, "verifying", restartMarkFields);
  const spawnData = spawnResult.data;
  const newPid = spawnData?.pid ?? null;
  const identity = identityVerdict(resumeSessionId, spawnData?.measuredSessionId ?? null);
  const liveness = await confirmStillRunning(newPid, identity, resumeSessionId ?? record.handle, {
    ...ctx.restartSettleMs !== void 0 ? { settleMs: ctx.restartSettleMs } : {},
    ...ctx.procRoot ? { procRoot: ctx.procRoot } : {},
    command
  });
  if (!liveness.ok) {
    await markNotRunning(ctx, record.handle);
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_died_after_spawn",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { handle: record.handle, pid: newPid, reason: liveness.reason }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_died_after_spawn",
      `The relaunched peer did not survive: ${liveness.reason}`,
      { handle: record.handle, pid: newPid, reason: liveness.reason }
    );
  }
  if (identity.mismatch) {
    await markNotRunning(ctx, record.handle);
    await clearRestartMark(ctx, record.handle);
    await writeEvent({
      event: "peer_restart_identity_mismatch",
      level: "error",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        expected: resumeSessionId,
        handle: record.handle,
        actual: identity.actual,
        pid: newPid,
        hint: "The peer is running but under a different session id \u2014 the record now points at an identity that no longer exists. Adopt the new id or stop the peer; do not trust lifecycle calls on this record."
      }
    });
    return errResult(
      req.id,
      req.tool,
      "restart_identity_mismatch",
      `Peer restarted as '${identity.actual ?? "unknown"}', not '${resumeSessionId}' \u2014 the resume did not take and the record now names an identity that is not running.`,
      { expected: resumeSessionId, handle: record.handle, actual: identity.actual, pid: newPid }
    );
  }
  await clearRestartMark(ctx, record.handle);
  await writeEvent({
    event: "peer_restarted",
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      handle: record.handle,
      reason: args.reason ?? null,
      force: args.force,
      mode: args.force ? "forced" : ready.kind === "acked" ? "graceful" : "no-host",
      resumedSessionId: resumeSessionId,
      resumeSource: resumeDecision.kind === "resume" ? resumeDecision.source : null,
      readyWaitedMs: ready.kind === "acked" ? ready.waitedMs : null,
      stoppedCleanly,
      measuredSessionId: identity.actual,
      envSource: record.observed.spawnEnv ? "stored" : "daemon",
      envHarvestedAt: record.observed.harvestedAt ?? null
    }
  });
  const wake = await wakePeer(req, ctx, {
    // The BRIDGE address, not the key — the same distinction step b) of this
    // protocol already makes when it ASKS the peer. Step g) TELLS it, and until
    // R3 it told a directory nobody drains.
    bridgeId: bridgeIdOf(record),
    sessionKey: spawnData?.sessionKey ?? sessionKey,
    reason: args.reason ?? "peer_restart",
    // WAS THE PEER ASKED? — not "did the stop report itself clean".
    //
    // Found by the acceptance run, in this release's own code. A forced stop
    // skips the courtesy, so `peer_stop` has nothing to measure and returns
    // `stoppedCleanly: null` — and the wake only warns on `false`. The forced
    // restart therefore produced the most reassuring possible message for the
    // peer least entitled to it: no warning at all, after being killed
    // mid-sentence.
    //
    // This is not the caller overriding a measurement. Whether we asked is a
    // fact this handler owns, and from the peer's side an unasked stop IS an
    // unclean one: whatever it had not written down at that moment is gone.
    stoppedCleanly: ready.kind === "acked" ? stoppedCleanly : false,
    event: "restarted",
    wakePrompt: RESTART_WAKE_PROMPT,
    ...ctx.wakeDelayMs !== void 0 ? { wakeDelayMs: ctx.wakeDelayMs } : {}
  });
  return okResult(req.id, req.tool, {
    handle: record.handle,
    // TOP LEVEL, all of it. A caller must not have to dig through two nested
    // results to learn whether the peer kept its context, whether it was asked
    // first, or whether it was told what happened.
    restarted: true,
    mode: args.force ? "forced" : ready.kind === "acked" ? "graceful" : "no-host",
    // Did the context survive? This is the question the whole release is about.
    resumedSessionId: resumeSessionId,
    resumeSource: resumeDecision.kind === "resume" ? resumeDecision.source : null,
    ...resumeDecision.kind === "fresh" ? { resumeSkipped: resumeDecision.why } : {},
    // MEASURED waits, never budgets.
    readyWaitedMs: ready.kind === "acked" ? ready.waitedMs : null,
    stoppedCleanly,
    measuredSessionId: identity.actual,
    // Step g). `false` means the peer is running and does not know why it
    // restarted — not fatal, and not something to leave unsaid either.
    reported: wake.injected,
    ...wake.injected ? {} : { reportNote: wake.error ?? "the wake was not injected" },
    stop: stopResult.data,
    spawn: spawnResult.data
  });
}

// src/handlers/team-adopt.ts
var log7 = makeLogger("daemon.adopt");
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
  const deadWindows = windows.filter((w) => w.dead);
  if (deadWindows.length > 0) {
    windows = windows.filter((w) => !w.dead);
    log7.warn("adopt_skipped_dead_panes", {
      count: deadWindows.length,
      targets: deadWindows.map((w) => ({ target: w.target, exitStatus: w.exitStatus }))
    });
  }
  const hostSessions = windows.length > 0 ? windows.map((w) => ({
    sessionKey: w.target,
    label: w.windowName || w.label,
    homeSession: w.session,
    pid: w.pid
  })) : (await ctx.hostDriver.listSessions()).filter((s) => sessionFilter === void 0 || s.sessionKey === sessionFilter).filter((s) => s.alive).map((s) => ({
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
    if (existing && existing.observed.status !== "stopped") {
      skips.push({
        sessionKey: c.sessionKey,
        reason: "already_adopted",
        details: `sessionId ${c.sessionId} already in state as '${existing.observed.status}'`
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
        handle: c.sessionId,
        desired: {
          team: args.team,
          label: windowLabelFor(c.label ?? c.sessionKey, args.team),
          // Carried from /proc so an adopted peer is restartable. Without these
          // the record is a name with no way to relaunch what it names.
          ...c.command ? { command: c.command } : {},
          ...c.spawnArgs ? { spawnArgs: c.spawnArgs } : {},
          ...c.cwd ? { cwd: c.cwd } : {},
          ...c.homeSession ? { homeSession: c.homeSession } : {},
          model: c.model ?? null,
          accountProfile: null
        },
        observed: {
          name: c.label ?? c.sessionKey,
          hostDriver: hostDriverName,
          tmuxTarget: c.sessionKey,
          pid: c.pid,
          status: "live",
          // Flags that the daemon did not start this process: `startedAt` is
          // when we adopted it, not when it actually booted.
          adopted: true,
          // Read out of a live process at adoption time — the definition of a
          // harvested value, and the one that poisoned the fleet on 08-04. It
          // gets a timestamp here so a later reader can judge its age instead
          // of trusting it forever.
          ...c.spawnEnv ? { spawnEnv: c.spawnEnv, harvestedAt: now } : {},
          model: c.model ?? null,
          startedAt: now,
          lastUpdatedAt: now
        }
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
var import_promises15 = require("node:fs/promises");
var import_node_path13 = require("node:path");
var PeerSpecSchema = external_exports.object({
  /**
   * The registry key for this peer — renamed from `sessionId` in R3
   * (v0.11.21). BREAKING, deliberately and without an alias.
   *
   * A layout names peers that do not exist yet, so this string cannot be a
   * session id: only a booted peer can mint one. Calling it `sessionId` is what
   * made `team_layout` hand the key to `--resume` (fixed v0.11.18) and address
   * a wake to a directory nobody drains (fixed here) — both times because the
   * field's NAME said it was an identity.
   */
  handle: external_exports.string().min(1),
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
  /**
   * Execute the plan. DEFAULT FALSE since R3 (v0.11.21) — BREAKING.
   *
   * This was the one bulk tool that acted unless told not to, while
   * `team_restart`, `team_adopt` and `team_stop` all preview first. The
   * asymmetry is not a preference: a mistyped team name here SPAWNS PEERS,
   * and the operator finds out afterwards. Four calls exist in the whole
   * history of the daemon (measured from `events.jsonl` 2026-08-08), all
   * ours, so the cost of the change is a flag and the cost of leaving it is
   * one bad afternoon.
   *
   * `apply: false` reports exactly what `apply: true` would do.
   */
  apply: external_exports.boolean().default(false),
  prune: external_exports.boolean().default(false),
  /**
   * Prune WITHOUT asking (v0.11.17). Default false: a peer dropped from a
   * layout gets the same courtesy as one told to sleep.
   *
   * v0.11.15 pinned prune to the impolite path with a TODO, because it was
   * impolite only for want of an alternative — `peer_stop` had no other mode.
   * Now it does. A peer being removed from a spec has as much unwritten work
   * as any other, so it is asked first, and a peer that does not answer is
   * REPORTED rather than killed. `pruneForce: true` is the old behaviour and
   * now has to be said.
   */
  pruneForce: external_exports.boolean().default(false),
  /** How long a pruned peer gets to acknowledge before it is reported as refused. */
  pruneAckTimeoutMs: external_exports.number().int().positive().max(6e5).optional(),
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
  return (0, import_node_path13.join)(teamsDir(), `${team}.json`);
}
async function loadTeamSpec(team) {
  try {
    const raw = await (0, import_promises15.readFile)(teamFilePath(team), "utf-8");
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
  const specIds = new Set(spec.peers.map((p) => p.handle));
  const stateIds = new Set(Object.keys(ctx.state.peers));
  const stoppedIds = new Set(
    Object.entries(ctx.state.peers).filter(([, rec]) => rec.observed.status === "stopped").map(([id]) => id)
  );
  const runningIds = new Set([...stateIds].filter((id) => !stoppedIds.has(id)));
  const toSpawn = spec.peers.filter((p) => !stateIds.has(p.handle));
  const toResume = spec.peers.filter((p) => stoppedIds.has(p.handle));
  const runningExtras = [...runningIds].filter((id) => !specIds.has(id));
  const toStop = args.prune ? runningExtras : [];
  const toForget = args.prune ? [...stoppedIds].filter((id) => !specIds.has(id)) : [];
  const diff = {
    team: spec.team,
    plannedSpawn: toSpawn.map((p) => p.handle),
    plannedResume: toResume.map((p) => p.handle),
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
    const record = ctx.state.peers[p.handle];
    const spawnReq = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:${label}:${p.handle}`,
      ts: req.ts,
      tool: "peer_spawn",
      args: {
        handle: p.handle,
        displayName: p.displayName,
        cwd: p.cwd,
        command: p.command,
        args: p.args,
        // Resuming a tombstone MUST pass `--resume <sessionId>`, otherwise the
        // peer comes back as a blank session and its transcript is orphaned.
        resume: forceResume || p.resume,
        // 🔴 WHICH transcript (v0.11.19) — and this is the tool where it matters
        // most, because this is the tool that MAKES handle-keyed peers.
        //
        // The spec names a peer before it exists, so `p.handle` is a handle.
        // Passing it to `--resume` was the v0.11.18 defect one tool over: a
        // handle matches no transcript, so Claude Code drops into its Resume
        // picker, the peer wedges at a prompt with a brand-new identity, and the
        // record is orphaned behind a pid that still matches.
        //
        // The identity survives the tombstone: `peer_stop keepInState` clears
        // status and pid, and leaves `observed.sessionId` and `identity`
        // untouched. So a resume can ask the record who it actually is.
        ...record?.observed.identity === "measured" && record.observed.sessionId ? { resumeSessionId: record.observed.sessionId } : {},
        // Fall back to what the peer was last running with, so a stop→start
        // round trip does not silently downgrade the model.
        model: p.model ?? record?.desired.model ?? record?.observed.model ?? null,
        accountProfile: p.accountProfile ?? record?.desired.accountProfile ?? null,
        extraAllowEnv: p.extraAllowEnv,
        extraEnv: p.extraEnv,
        // So the window gets the short label while the record keeps the full name.
        team: spec.team
      },
      requestedBy: req.requestedBy
    };
    return handlePeerSpawn(spawnReq, ctx);
  };
  const stampTeam = async (sessionId) => {
    await applyStateChange(ctx.state, (draft) => {
      const rec = draft.peers[sessionId];
      if (rec) rec.desired.team = spec.team;
    });
  };
  const spawnedOk = [];
  const spawnedFailed = [];
  for (const p of toSpawn) {
    const res = await spawnOne(p, false, "spawn");
    if (res.outcome === "ok") {
      await stampTeam(p.handle);
      spawnedOk.push(p.handle);
    } else {
      spawnedFailed.push({ handle: p.handle, err: res.error?.message ?? "unknown" });
    }
  }
  const resumedOk = [];
  const resumedFailed = [];
  const wakeOutcomes = [];
  for (const p of toResume) {
    const stoppedCleanly = ctx.state.peers[p.handle]?.observed.stoppedCleanly ?? null;
    const res = await spawnOne(p, true, "resume");
    if (res.outcome !== "ok") {
      resumedFailed.push({ handle: p.handle, err: res.error?.message ?? "unknown" });
      continue;
    }
    await stampTeam(p.handle);
    resumedOk.push(p.handle);
    if (!args.wake) continue;
    const data = res.data;
    const rec = ctx.state.peers[p.handle];
    const outcome = await wakePeer(req, ctx, {
      // The BRIDGE address. `team_layout` is the tool that MAKES handle-keyed
      // records, so it is the caller for which the handle and the bridge id
      // most often differ — and whose wake was therefore the least likely to
      // arrive. The fallback covers a record that vanished mid-run only.
      bridgeId: rec ? bridgeIdOf(rec) : p.handle,
      sessionKey: data?.sessionKey ?? p.displayName,
      reason: `team_layout_resume:${spec.team}`,
      stoppedCleanly,
      ...args.wakeDelayMs !== void 0 ? { wakeDelayMs: args.wakeDelayMs } : {}
    });
    wakeOutcomes.push(outcome);
  }
  const stoppedOk = [];
  const stoppedFailed = [];
  const stoppedRefused = [];
  const forgotten = [];
  if (args.prune) {
    for (const id of toStop) {
      const stopReq = {
        schemaVersion: req.schemaVersion,
        id: `${req.id}:stop:${id}`,
        ts: req.ts,
        tool: "peer_stop",
        args: {
          peer: id,
          reason: `team_layout_prune:${spec.team}`,
          // The v0.11.15 TODO, resolved (v0.11.17).
          //
          // That pin was `skipCourtesy: true` with a note saying the decision
          // was not obvious and belonged to a later phase. It is resolved the
          // other way: prune ASKS. A peer removed from a layout has as much
          // unwritten work as one told to sleep, and prune was impolite only
          // because `peer_stop` had no other mode when this was written.
          //
          // A peer that does not answer is left running and reported — pruning
          // is reconciliation, and reconciliation that destroys unsaved work to
          // make a list come true has the priority backwards.
          ...args.pruneForce ? { force: true } : {},
          ...args.pruneAckTimeoutMs !== void 0 ? { ackTimeoutMs: args.pruneAckTimeoutMs } : {}
        },
        requestedBy: req.requestedBy
      };
      const res = await handlePeerStop(stopReq, ctx);
      if (res.outcome === "ok") {
        stoppedOk.push(id);
      } else if (res.error?.code === "stop_ack_timeout") {
        stoppedRefused.push({ handle: id, detail: res.error?.message ?? "no ack" });
      } else {
        stoppedFailed.push({ handle: id, err: res.error?.message ?? "unknown" });
      }
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
  const wokenOk = wakeOutcomes.filter((w) => w.injected).map((w) => w.bridgeId);
  const wokenSilent = wakeOutcomes.filter((w) => !w.injected).map((w) => ({ bridgeId: w.bridgeId, err: w.error ?? "not injected" }));
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
      stoppedRefused,
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
    stoppedRefused,
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
var import_node_fs6 = require("node:fs");
var import_node_path14 = require("node:path");
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
  return (0, import_node_fs6.existsSync)((0, import_node_path14.join)(procRoot, String(pid)));
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
  const windowsPerSession = /* @__PURE__ */ new Map();
  for (const w of windows)
    windowsPerSession.set(w.session, (windowsPerSession.get(w.session) ?? 0) + 1);
  const deadPanes = /* @__PURE__ */ new Map();
  for (const w of windows) {
    if (w.dead) {
      const entry = { exitStatus: w.exitStatus, label: w.windowName || w.label, target: w.target };
      deadPanes.set(w.target, entry);
      if (windowsPerSession.get(w.session) === 1)
        deadPanes.set(trustCanonicalTarget(w.session), entry);
    }
  }
  const hostWindowIndex = /* @__PURE__ */ new Map();
  for (const w of windows) {
    if (typeof w.window === "number") hostWindowIndex.set(w.target, w.window);
  }
  const records = Object.values(ctx.state.peers).filter(
    (r) => args.team === void 0 || r.desired.team === args.team
  );
  const drift = [];
  const healthy = [];
  const accountedPids = /* @__PURE__ */ new Set();
  for (const rec of records) {
    if (rec.observed.pid !== null) accountedPids.add(rec.observed.pid);
    if (rec.observed.status === "stopped") {
      healthy.push(rec.handle);
      continue;
    }
    const base = {
      handle: rec.handle,
      name: rec.observed.name,
      team: rec.desired.team ?? null,
      recordedPid: rec.observed.pid,
      tmuxTarget: rec.observed.tmuxTarget
    };
    const alive = rec.observed.pid !== null && pidAlive(rec.observed.pid, procRoot);
    if (!alive) {
      const corpse = rec.observed.tmuxTarget ? deadPanes.get(rec.observed.tmuxTarget) : void 0;
      drift.push({
        ...base,
        kind: "dead",
        actualPid: null,
        detail: rec.observed.pid === null ? `record is '${rec.observed.status}' with no pid at all` : `record is '${rec.observed.status}' but pid ${rec.observed.pid} is not running${corpse ? ` \u2014 its pane is still standing and holds exit status ${corpse.exitStatus ?? "unknown"}; read it with \`tmux capture-pane -p -S -2000 -t ${corpse.target}\` before removing it` : " and its pane is gone"}${// A dead peer with a restart mark on it is not simply dead: a
        // restart was in flight when it stopped being observable, and
        // the obvious remedy for "dead" — relaunch it — is the
        // dangerous one if that restart was inside its spawn. Reported
        // here rather than as its own entry, because `dead` is the
        // measured fact and this is what it means.
        rec.observed.restartRequest ? `. \u{1F534} A RESTART WAS UNDERWAY (phase '${rec.observed.restartRequest.phase}', requested at ${rec.observed.restartRequest.requestedAt}) \u2014 check the host for a process this record does not name before relaunching anything` : ""}`
      });
      continue;
    }
    const pending = rec.observed.stopRequest;
    if (pending && rec.observed.status === "stopping") {
      const askedAt = Date.parse(pending.requestedAt);
      const ageMs = Number.isNaN(askedAt) ? null : Date.now() - askedAt;
      drift.push({
        ...base,
        kind: "stop_pending",
        actualPid: rec.observed.pid,
        detail: `a stop was requested at ${pending.requestedAt}${ageMs === null ? "" : ` (${Math.round(ageMs / 1e3)}s ago)`} and never resolved \u2014 the peer is STILL RUNNING. Call peer_stop again to keep waiting on the same request (a late ack still counts), peer_stop with force:true to end it now, or leave it be.`
      });
      continue;
    }
    const restarting = rec.observed.restartRequest;
    if (restarting) {
      const askedAt = Date.parse(restarting.requestedAt);
      const ageMs = Number.isNaN(askedAt) ? null : Date.now() - askedAt;
      const remedy = {
        "ready-ack": "the peer was asked to get ready and is UNTOUCHED \u2014 call peer_restart again to resume the same request, or leave it be",
        stopping: "the stop may or may not have completed \u2014 run team_reconcile against the host first, then peer_restart",
        spawning: "\u{1F534} a process may exist that no record names \u2014 CHECK THE HOST before relaunching anything, or you risk a second peer behind this handle",
        verifying: "a process is running and its identity was never confirmed \u2014 measure it (team_reconcile) before trusting lifecycle calls on this record"
      };
      drift.push({
        ...base,
        kind: "restart_pending",
        actualPid: rec.observed.pid,
        detail: `a restart was requested at ${restarting.requestedAt}${ageMs === null ? "" : ` (${Math.round(ageMs / 1e3)}s ago)`} by ${restarting.requestId} and never resolved \u2014 abandoned in the '${restarting.phase}' phase. ${remedy[restarting.phase] ?? "check the host before acting"}.`
      });
      continue;
    }
    if (rec.observed.tmuxTarget !== null && hostTargets.size > 0 && !hostTargets.has(rec.observed.tmuxTarget)) {
      drift.push({
        ...base,
        kind: "host_missing",
        actualPid: rec.observed.pid,
        detail: `pid ${rec.observed.pid} is alive but host target '${rec.observed.tmuxTarget}' no longer exists`
      });
      continue;
    }
    const targetPid = rec.observed.tmuxTarget !== null ? hostTargets.get(rec.observed.tmuxTarget) ?? null : null;
    const targetOwnsRecord = targetPid !== null && rec.observed.pid !== null && await ownsProcess(inspector, targetPid, rec.observed.pid);
    if (targetPid !== null && rec.observed.pid !== null && targetPid !== rec.observed.pid && !targetOwnsRecord) {
      drift.push({
        ...base,
        kind: "pid_changed",
        actualPid: targetPid,
        detail: `host target '${rec.observed.tmuxTarget}' holds pid ${targetPid}, record says ${rec.observed.pid}`
      });
      continue;
    }
    healthy.push(rec.handle);
  }
  const knownSessionIds = new Set(Object.keys(ctx.state.peers));
  for (const proc of livePeers) {
    if (proc.sessionId && knownSessionIds.has(proc.sessionId)) continue;
    if (accountedPids.has(proc.pid)) continue;
    drift.push({
      kind: "unmanaged",
      handle: proc.sessionId,
      name: null,
      team: null,
      recordedPid: null,
      actualPid: proc.pid,
      tmuxTarget: null,
      detail: `pid ${proc.pid} is a Claude peer with no record${proc.sessionId ? "" : " and no resolvable session id"}`
    });
  }
  const recordedTargets = new Set(
    Object.values(ctx.state.peers).map((r) => r.observed.tmuxTarget).filter((t) => t !== null)
  );
  const aliasesByPane = /* @__PURE__ */ new Map();
  for (const [alias, info] of deadPanes) {
    const set = aliasesByPane.get(info.target) ?? /* @__PURE__ */ new Set();
    set.add(alias);
    aliasesByPane.set(info.target, set);
  }
  for (const [target, aliases] of aliasesByPane) {
    if ([...aliases].some((a) => recordedTargets.has(a))) continue;
    const info = deadPanes.get(target);
    if (!info) continue;
    drift.push({
      kind: "dead_pane",
      handle: null,
      name: info.label,
      team: null,
      recordedPid: null,
      actualPid: null,
      tmuxTarget: target,
      detail: `window '${info.label}' (${target}) is held open after its process exited${info.exitStatus === null ? "" : ` with status ${info.exitStatus}`} and belongs to no record \u2014 read it with \`tmux capture-pane -p -S -2000 -t ${target}\`, then \`tmux kill-window -t ${target}\``
    });
  }
  const marked = [];
  if (args.markDead) {
    const deadIds = drift.filter((d) => d.kind === "dead" && d.handle).map((d) => d.handle);
    if (deadIds.length > 0) {
      await applyStateChange(ctx.state, (draft) => {
        for (const id of deadIds) {
          const rec = draft.peers[id];
          if (rec) {
            rec.observed.status = "unknown";
            rec.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
          }
        }
      });
      marked.push(...deadIds);
    }
  }
  const measured = [];
  await applyStateChange(ctx.state, (draft) => {
    for (const rec of Object.values(draft.peers)) {
      if (rec.observed.tmuxTarget === null) continue;
      const idx = hostWindowIndex.get(rec.observed.tmuxTarget);
      if (idx === void 0 || rec.observed.windowIndex === idx) continue;
      rec.observed.windowIndex = idx;
      measured.push(rec.handle);
    }
  });
  const identified = [];
  for (const rec of Object.values(ctx.state.peers)) {
    if (rec.observed.identity === "measured") continue;
    if (rec.observed.pid === null || !pidAlive(rec.observed.pid, procRoot)) continue;
    const outcome = await measureIdentity(rec.observed.pid, {
      // Short: this is a sweep over the whole fleet, not a spawn waiting on one
      // peer, and an unmeasurable identity here simply waits for the next pass.
      timeoutMs: 400,
      ...ctx.processInspector ? { inspector: ctx.processInspector } : {},
      procRoot
    });
    if (outcome.kind !== "measured") continue;
    const m = outcome.measurement;
    await applyStateChange(ctx.state, (draft) => {
      const target = draft.peers[rec.handle];
      if (!target) return;
      target.observed.sessionId = m.sessionId;
      target.observed.identity = "measured";
      target.observed.identityAt = m.measuredAt;
      target.observed.identitySource = m.source;
      target.observed.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
    });
    identified.push({ handle: rec.handle, sessionId: m.sessionId, source: m.source });
    await writeEvent({
      event: "peer_identity_measured",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: rec.handle,
        sessionKey: rec.observed.tmuxTarget,
        pid: m.pid,
        measuredSessionId: m.sessionId,
        source: m.source,
        by: "team_reconcile",
        note: "Identity was unknown since spawn and has now been read from the running process."
      }
    });
  }
  const windowDrift = Object.values(ctx.state.peers).filter(
    (r) => r.desired.windowIndex !== void 0 && r.observed.windowIndex !== void 0 && r.desired.windowIndex !== r.observed.windowIndex
  ).map((r) => ({
    handle: r.handle,
    name: r.observed.name,
    desired: r.desired.windowIndex,
    observed: r.observed.windowIndex
  }));
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
    // Reported separately from `drift`, on purpose. The entries above mean
    // "the control plane's belief about this peer is wrong"; a window sitting
    // at a different index means only that somebody moved it. Folding a
    // cosmetic disagreement into the same count that gates a fleet roll would
    // train an operator to ignore both.
    windowIndexDrift: windowDrift,
    windowIndexMeasured: measured.length,
    // Peers whose identity was unknown since spawn and has now been read.
    identitiesMeasured: identified,
    // Still unknown after this pass — running, but not yet cross-referenceable
    // with the bridge. NOT dead, and must not be read as such.
    identityUnknown: Object.values(ctx.state.peers).filter((r) => r.observed.identity === "unknown").map((r) => ({ handle: r.handle, name: r.observed.name, pid: r.observed.pid })),
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
    handle: rec.handle,
    name: rec.observed.name,
    status: rec.observed.status,
    team: rec.desired.team ?? null,
    pid: rec.observed.pid,
    tmuxTarget: rec.observed.tmuxTarget,
    adopted: rec.observed.adopted ?? false
  };
}
function callerTeamOf5(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
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
      if (rec.desired.team === args.team) found.push(rec);
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
          knownTeams: [
            ...new Set(Object.values(ctx.state.peers).map((p) => p.desired.team ?? "(none)"))
          ]
        }
      );
    }
  } else {
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
      if (!found.some((f) => f.handle === rec.handle)) found.push(rec);
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
    for (const rec of found) delete draft.peers[rec.handle];
  });
  for (const rec of found) {
    await writeEvent({
      event: "peer_released",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: {
        handle: rec.handle,
        name: rec.observed.name,
        team: rec.desired.team ?? null,
        pid: rec.observed.pid,
        tmuxTarget: rec.observed.tmuxTarget,
        adopted: rec.observed.adopted ?? false,
        statusAtRelease: rec.observed.status,
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
    released: found.map((r) => r.handle)
  });
}

// src/handlers/peer-order.ts
var COORDINATOR_ROLE = "velitel";
function readRole(peer) {
  const name = peer.name ?? null;
  const declared = peer.role;
  if (typeof declared === "string" && declared.length > 0) {
    return { name, isCoordinator: declared === COORDINATOR_ROLE, source: "declared" };
  }
  if (name?.includes(COORDINATOR_ROLE)) {
    return { name, isCoordinator: true, source: "name" };
  }
  return { name, isCoordinator: false, source: "none" };
}
function orderCoordinatorLast(peers, read) {
  const verdicts = peers.map((p) => readRole(read(p)));
  const rest = peers.filter((_, i) => !verdicts[i]?.isCoordinator);
  const last = peers.filter((_, i) => verdicts[i]?.isCoordinator);
  const coordinators = verdicts.filter((v) => v.isCoordinator);
  return {
    ordered: [...rest, ...last],
    coordinators,
    inferred: coordinators.some((v) => v.source === "name")
  };
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
  /**
   * Restart every member without asking (v0.11.18).
   *
   * A pass-through to the primitive, not a second mechanism: `peer_restart`
   * decides what force means, and this only carries the word. Same rule
   * applies to every member — force skips WAITING (the ready-ack, the stop
   * courtesy) and never EVIDENCE (the pane archive, the identity check after
   * the relaunch, and the message telling each peer its anchor may be
   * half-written).
   *
   * `settleMs` is NOT skipped. The gap between peers is not a courtesy — it
   * is what stops a rolling restart from becoming a simultaneous one.
   */
  force: external_exports.boolean().default(false),
  /** Keep going after a peer fails to restart. Off, deliberately. */
  continueOnError: external_exports.boolean().default(false),
  dryRun: external_exports.boolean().default(true)
}).strict().refine((a) => a.peers === void 0 !== (a.team === void 0), {
  message: "pass exactly one of `peers` or `team`"
});
function orderPeers(records) {
  return orderCoordinatorLast(records, (r) => ({
    role: r.desired.role,
    name: r.observed.name
  }));
}
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
function callerTeamOf6(req, ctx) {
  return ctx.state.peers[req.requestedBy.sessionId]?.desired.team ?? null;
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
    selected = Object.values(ctx.state.peers).filter((r) => r.desired.team === args.team);
    if (selected.length === 0) {
      return errResult(req.id, req.tool, "team_not_found", `No peers under team '${args.team}'`, {
        team: args.team
      });
    }
  } else {
    selected = [];
    for (const key of args.peers ?? []) {
      const resolved = resolvePeerRef(ctx.state.peers, key, callerTeamOf6(req, ctx));
      if (resolved.kind === "ambiguous") {
        ambiguous2.push({ ref: key, candidates: resolved.candidates });
        continue;
      }
      const rec = resolved.kind === "found" ? resolved.record : null;
      if (!rec) {
        notFound.push(key);
        continue;
      }
      if (!selected.some((s) => s.handle === rec.handle)) selected.push(rec);
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
  const ordering = orderPeers(selected);
  const ordered = ordering.ordered;
  const unrestartable = ordered.filter((r) => !r.desired.command);
  if (unrestartable.length > 0) {
    await writeEvent({
      event: "team_restart_refused",
      level: "warn",
      by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
      requestId: req.id,
      details: { missingLaunchParams: unrestartable.map((r) => r.handle) }
    });
    return errResult(
      req.id,
      req.tool,
      "launch_params_missing",
      `${unrestartable.length} of ${ordered.length} peers have no recorded command and would relaunch as a bare 'claude'. Nothing was restarted.`,
      {
        peers: unrestartable.map((r) => ({ handle: r.handle, name: r.observed.name })),
        hint: "Records written before v0.10.3 lack launch parameters. Re-spawn those peers, or adopt them again with a daemon that reads /proc."
      }
    );
  }
  const plan = {
    dryRun: args.dryRun,
    reason: args.reason ?? null,
    settleMs: args.settleMs,
    // In the PLAN, because a dry run whose preview omits `force` would show an
    // operator a gentle roll and then perform a forced one.
    force: args.force,
    continueOnError: args.continueOnError,
    order: ordered.map((r) => ({
      handle: r.handle,
      name: r.observed.name,
      tmuxTarget: r.observed.tmuxTarget,
      pid: r.observed.pid,
      command: r.desired.command ?? null,
      cwd: r.desired.cwd ?? null
    })),
    // Who was put last, and on whose authority — a name match is a guess and an
    // operator reading this plan needs to see the difference before trusting it.
    coordinators: ordering.coordinators,
    coordinatorInferredFromName: ordering.inferred
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
        handle: rec.handle,
        name: rec.observed.name,
        outcome: "skipped",
        pidBefore: rec.observed.pid,
        pidAfter: null
      });
      continue;
    }
    const pidBefore = rec.observed.pid;
    const sub = {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:restart:${i}`,
      ts: req.ts,
      tool: "peer_restart",
      args: { peer: rec.handle, reason: args.reason ?? "team_restart", force: args.force },
      requestedBy: req.requestedBy
    };
    const res = await handlePeerRestart(sub, ctx);
    if (res.outcome === "error") {
      results.push({
        handle: rec.handle,
        name: rec.observed.name,
        outcome: "failed",
        pidBefore,
        pidAfter: null,
        error: res.error?.message ?? "peer_restart failed"
      });
      if (!args.continueOnError) stoppedEarly = true;
      continue;
    }
    results.push({
      handle: rec.handle,
      name: rec.observed.name,
      outcome: "restarted",
      pidBefore,
      pidAfter: ctx.state.peers[rec.handle]?.observed.pid ?? null
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
    restarted: restarted.map((r) => r.handle),
    failed: failed.map((r) => ({ handle: r.handle, error: r.error })),
    // Named, not merely absent from the success list: an operator has to know
    // which peers were never touched so they can finish the roll-out.
    skipped: skipped.map((r) => r.handle),
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
  /**
   * NOT IMPLEMENTED, and REFUSED rather than ignored (R3, v0.11.21).
   *
   * The schema accepted it, the response echoed it back, and `peers` held the
   * whole fleet. A caller asking for team `ai` got `team: "ai"` next to all
   * twenty-six peers — an answer that LOOKS filtered. The description
   * admitted it, which does not help: a reader trusts the shape of the reply,
   * not the paragraph about it.
   *
   * An argument that is accepted, echoed and ignored is worse than one that
   * is refused. Kept in the schema (rather than dropped, or typed `never`)
   * only so the refusal can say something an operator can act on — `Expected
   * never, received string` is not that sentence.
   */
  team: external_exports.string().min(1).optional(),
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
  if (args.team !== void 0) {
    return errResult(
      req.id,
      req.tool,
      "not_implemented",
      "filtering by team is not implemented; omit `team` and read `peers[].team` instead. Until v0.11.21 this argument was accepted and silently ignored, so a filtered-looking answer contained the whole fleet.",
      { requested: args.team }
    );
  }
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
    const key = record.observed.tmuxTarget ?? record.observed.name;
    const host = hostByKey.get(key);
    return {
      // The HANDLE, not the peer's session identity (v0.11.16, defect N4). It
      // is how you address this peer and it is the registry key; whether it
      // also happens to BE the session id is answered by `identity` below.
      handle: record.handle,
      name: record.observed.name,
      hostDriver: record.observed.hostDriver,
      tmuxTarget: record.observed.tmuxTarget,
      status: record.observed.status,
      // The measured Claude session id, and how much of a claim it is.
      // `unknown` means the process is RUNNING and we cannot yet say who it is
      // — a live peer, not a dead one, and never to be shown as the latter.
      measuredSessionId: record.observed.sessionId ?? null,
      identity: record.observed.identity ?? null,
      model: record.observed.model,
      accountProfile: record.desired.accountProfile,
      pid: record.observed.pid,
      startedAt: record.observed.startedAt,
      lastUpdatedAt: record.observed.lastUpdatedAt,
      hostAlive: host !== void 0,
      hostPid: host?.pid ?? null
    };
  });
  return okResult(req.id, req.tool, {
    daemonVersion: ctx.daemonVersion,
    hostDriver: ctx.hostDriver.name,
    // Always null now that the argument is refused. Kept so the response shape
    // does not change under a caller that never passed it.
    team: null,
    peerCount: peers.length,
    peers: args.verbose ? peers : peers.map(({ handle, name, status, hostAlive, identity }) => ({
      handle,
      name,
      status,
      // Surfaced even in the compact listing: a peer whose identity is
      // unknown cannot be cross-referenced with peer_list, and finding that
      // out from a `verbose` flag is finding it out too late.
      ...identity === "unknown" ? { identity } : {},
      hostAlive
    }))
  });
}

// src/handlers/team-stop.ts
var import_promises16 = require("node:fs/promises");
var import_node_path15 = require("node:path");
var DEFAULT_ANCHOR_TIMEOUT_MS2 = 12e4;
var DEFAULT_ACK_POLL_MS2 = 500;
var PeerOrderableSchema = external_exports.object({
  /** Registry key — renamed from `sessionId` in R3 (v0.11.21). See team_layout. */
  handle: external_exports.string().min(1),
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
  return (0, import_node_path15.join)(teamsDir(), `${team}.json`);
}
async function loadTeamOrder(team) {
  try {
    const raw = await (0, import_promises16.readFile)(teamFilePath2(team), "utf-8");
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
async function stopSinglePeer(req, ctx, peer, args, threadId, anchorTimeoutMs, ackPollMs) {
  const record = ctx.state.peers[peer.handle];
  if (!record) {
    return { handle: peer.handle, displayName: peer.displayName, outcome: "dead" };
  }
  const sessionKey = record.observed.tmuxTarget ?? record.observed.name;
  const callStop = async (force, label) => handlePeerStop(
    {
      schemaVersion: req.schemaVersion,
      id: `${req.id}:stop:${peer.handle}${force ? ":force" : ""}`,
      ts: req.ts,
      tool: "peer_stop",
      args: {
        peer: peer.handle,
        reason: `team_stop:${args.team}:${label}`,
        force,
        // The team keeps its members as tombstones so `team_layout apply` can
        // resume the same session ids later.
        keepInState: true,
        ...force ? {} : { ackTimeoutMs: anchorTimeoutMs, ackPollMs }
      },
      requestedBy: req.requestedBy
    },
    ctx
  );
  let res = await callStop(false, "graceful");
  let escalated = false;
  if (res.outcome === "error") {
    if (res.error?.code !== "stop_ack_timeout") {
      return {
        handle: peer.handle,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message
      };
    }
    if (!args.force) {
      await writeEvent({
        event: "stop_ack_timeout",
        level: "warn",
        by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
        requestId: req.id,
        details: {
          handle: peer.handle,
          sessionKey,
          team: args.team,
          threadId,
          timeoutMs: anchorTimeoutMs,
          note: "peer left running \u2014 pass force:true to end it anyway"
        }
      });
      return { handle: peer.handle, displayName: peer.displayName, outcome: "skipped" };
    }
    escalated = true;
    res = await callStop(true, "forced");
    if (res.outcome === "error") {
      return {
        handle: peer.handle,
        displayName: peer.displayName,
        outcome: "failed",
        err: res.error?.message
      };
    }
  }
  const mode = res.data?.mode ?? null;
  const outcome = mode === "already-gone" ? "dead" : escalated || mode === "forced" ? "forced" : "cleanly";
  const event = outcome === "dead" ? "peer_stopped_dead" : outcome === "cleanly" ? "peer_stopped_cleanly" : "peer_stopped_forced";
  await writeEvent({
    event,
    by: { sessionId: req.requestedBy.sessionId, name: req.requestedBy.name },
    requestId: req.id,
    details: {
      handle: peer.handle,
      sessionKey,
      team: args.team,
      threadId,
      mode,
      // The primitive's own thread, so a reader can follow the ask across both
      // audit trails instead of guessing which run this belonged to.
      stopThreadId: res.data?.threadId ?? null,
      ackWaitedMs: res.data?.ackWaitedMs ?? null
    }
  });
  if (outcome !== "dead") {
    await publishLifecycleEvent({
      event: outcome === "cleanly" ? "peer_stopped_cleanly" : "peer_stopped_forced",
      handle: peer.handle,
      sessionKey,
      details: { team: args.team, threadId }
    });
  }
  return { handle: peer.handle, displayName: peer.displayName, outcome };
}
function orderPeersForStop(peers) {
  return orderCoordinatorLast(peers, (p) => ({ role: p.role, name: p.displayName ?? null }));
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
  const stopOrder = orderPeersForStop(spec.peers);
  const ordered = stopOrder.ordered;
  const anchorTimeoutMs = args.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS2;
  const ackPollMs = args.ackPollMs ?? DEFAULT_ACK_POLL_MS2;
  const threadId = `team-stop:${spec.team}:${Date.now().toString(36)}`;
  if (args.dryRun) {
    return okResult(req.id, req.tool, {
      mode: "dryRun",
      team: spec.team,
      order: ordered.map((p) => ({
        handle: p.handle,
        displayName: p.displayName,
        role: p.role ?? null
      })),
      // Who was put last, and on whose authority — a name match is a guess and an
      // operator reading this plan needs to see the difference before trusting it.
      coordinators: stopOrder.coordinators,
      coordinatorInferredFromName: stopOrder.inferred,
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
      order: ordered.map((p) => p.handle),
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
    stoppedCleanly: outcomes.filter((o) => o.outcome === "cleanly").map((o) => o.handle),
    stoppedForced: outcomes.filter((o) => o.outcome === "forced").map((o) => o.handle),
    stoppedDead: outcomes.filter((o) => o.outcome === "dead").map((o) => o.handle),
    skipped: outcomes.filter((o) => o.outcome === "skipped").map((o) => o.handle),
    failedKill: outcomes.filter((o) => o.outcome === "failed").map((o) => ({ sessionId: o.handle, err: o.err ?? "unknown" }))
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
  control_status: handleControlStatus,
  control_config: handleControlConfig
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
var import_promises17 = require("node:fs/promises");
var log8 = makeLogger("daemon.heartbeat");
var timer = null;
async function touch() {
  const now = /* @__PURE__ */ new Date();
  try {
    await (0, import_promises17.utimes)(heartbeatPath(), now, now);
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT") {
      await (0, import_promises17.writeFile)(heartbeatPath(), "");
    } else {
      log8.warn("heartbeat_touch_failed", { err: String(e) });
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
var import_node_fs7 = require("node:fs");
var import_promises18 = require("node:fs/promises");
var import_node_path16 = require("node:path");
var import_node_util = require("node:util");

// src/hosts/input-line.ts
var INPUT_MARKER = "\u276F";
var PASTE_COLLAPSE_LIMIT = 800;
var MAX_CLEAR_STROKES = 40;
var CLEAR_STROKE_BATCH = 4;
var KILL_RING_HINT = "Ctrl+Y to paste deleted text";
var RULE = /^[─-╿\s]+$/;
function readInputLine(captured) {
  const lines = captured.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.includes(INPUT_MARKER)) {
      at = i;
      break;
    }
  }
  if (at < 0) return { kind: "no-marker" };
  const markerLine = lines[at] ?? "";
  const contentCol = markerLine.indexOf(INPUT_MARKER) + INPUT_MARKER.length + 1;
  const head = markerLine.slice(contentCol);
  if (head.trim().length === 0) return { kind: "empty" };
  const rows = [markerLine];
  let boxWidth = 0;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (RULE.test(line)) {
      boxWidth = line.length - contentCol;
      break;
    }
    rows.push(line);
  }
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? "";
    parts.push(raw.slice(contentCol).trimEnd());
    const wordWrapped = boxWidth > 0 && raw.length < boxWidth;
    if (i < rows.length - 1 && wordWrapped) parts.push(" ");
  }
  const text = parts.join("").trim();
  return text.length === 0 ? { kind: "empty" } : { kind: "draft", text };
}
function paneContains(captured, keys) {
  const strip = (s) => s.replace(/\s+/g, "");
  const needle = strip(keys);
  if (needle.length === 0) return true;
  const haystack = strip(captured);
  const probe = needle.length > 40 ? needle.slice(-40) : needle;
  return haystack.includes(probe);
}
function inputLineHolds(captured, keys) {
  const inputLine = readInputLine(captured);
  if (inputLine.kind === "draft" && paneContains(inputLine.text, keys)) {
    return { delivered: true, where: "input-line", inputLine };
  }
  if (inputLine.kind === "no-marker") {
    return {
      delivered: paneContains(captured, keys),
      where: "no-input-box",
      inputLine
    };
  }
  const where = paneContains(captured, keys) ? "elsewhere-on-pane" : "absent";
  return { delivered: false, where, inputLine };
}
function refusePayload(keys) {
  if (/[\n\r]/.test(keys)) {
    return {
      reason: "multiline",
      message: "payload contains a newline \u2014 tmux sends each one as Enter, which would submit the payload in pieces. A payload is one line; see docs/SEND-KEYS.md."
    };
  }
  if (keys.length > PASTE_COLLAPSE_LIMIT) {
    return {
      reason: "too-long",
      message: `payload is ${keys.length} characters \u2014 Claude Code collapses anything over ${PASTE_COLLAPSE_LIMIT} into a "[Pasted text]" placeholder, after which delivery cannot be verified. See docs/SEND-KEYS.md.`
    };
  }
  return null;
}
function displacedDraftNotice() {
  return "\u26A0 claude-bridge cleared your unsent draft to deliver an automated command \u2014 press Ctrl+Y to get it back";
}

// src/hosts/tmux-driver.ts
var PROBE_RETRY_PAUSE_MS = 200;
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var log9 = makeLogger("daemon.host.tmux");
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
  const envBin = (0, import_node_fs7.existsSync)("/usr/bin/env") ? "/usr/bin/env" : "env";
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
var HUMAN_NOTICE_MS = 8e3;
var TmuxDriver = class _TmuxDriver {
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
          "#{window_id}	#{session_name}	#{window_index}	#{window_name}	#{pane_pid}	#{pane_dead}	#{pane_dead_status}"
        ],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [windowId, session, idxStr, windowName, pidStr, deadStr, exitStr] = trimmed.split("	");
        if (!windowId || !session || idxStr === void 0) continue;
        const window = Number.parseInt(idxStr, 10);
        if (Number.isNaN(window)) continue;
        const target = trustCanonicalTarget(windowId);
        if (seen.has(target)) continue;
        seen.add(target);
        const pid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        const exitStatus = exitStr ? Number.parseInt(exitStr, 10) : Number.NaN;
        out.push({
          target,
          label: `${session}:${window}`,
          session,
          window,
          windowName: windowName ?? "",
          // Still the corpse's pid when `dead` is set — see HostWindowRecord.
          pid: Number.isNaN(pid) ? null : pid,
          dead: deadStr === "1",
          exitStatus: Number.isNaN(exitStatus) ? null : exitStatus
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
    const canonicalKey = canonicalHostTarget(opts.sessionKey);
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
      log9.info("tmux_home_session_recreated", { session: parentSession });
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
      if (asWindow) createdWindowId = stdout.trim() ? trustCanonicalTarget(stdout.trim()) : null;
    } catch (e) {
      log9.error("tmux_spawn_failed", {
        sessionKey: opts.sessionKey,
        canonicalKey,
        err: e instanceof Error ? e.message : String(e)
      });
      throw e;
    }
    if (canonicalKey !== opts.sessionKey) {
      log9.info("session_key_canonicalized", {
        raw: opts.sessionKey,
        canonical: canonicalKey
      });
    }
    const effectiveKey = createdWindowId ?? canonicalKey;
    await this.tmux(
      ["set-window-option", "-t", effectiveKey, "remain-on-exit", "on"],
      QUERY_TIMEOUT_MS
    ).catch((e) => {
      log9.warn("tmux_remain_on_exit_not_set", {
        sessionKey: effectiveKey,
        err: e instanceof Error ? e.message.split("\n")[0] : String(e)
      });
    });
    const probe = await this.probePanePid(effectiveKey);
    if (probe.kind === "no-such-target") {
      log9.error("tmux_spawn_target_gone", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        raw: probe.raw,
        note: "tmux says the target does not exist \u2014 the command exited immediately"
      });
    } else if (probe.kind === "unavailable") {
      log9.error("tmux_spawn_pid_unavailable", {
        sessionKey: opts.sessionKey,
        canonicalKey: effectiveKey,
        raw: probe.raw,
        attempts: probe.attempts,
        note: "could not determine whether anything is running \u2014 the session is left standing for inspection"
      });
    }
    return {
      sessionKey: effectiveKey,
      alive: probe.kind === "pid",
      pid: probe.kind === "pid" ? probe.pid : null,
      probe
    };
  }
  async kill(sessionKey, opts = {}) {
    const t = parseHostTarget(sessionKey);
    const canonical = t.kind === "window" ? t.windowId : t.session;
    const before = await this.probePanePid(canonical, 1);
    if (before.kind === "dead") {
      const saved = await this.archivePane(
        canonical,
        `pane held exit status ${before.exitStatus ?? "unknown"} before teardown`
      );
      if (saved === null) {
        log9.error("tmux_kill_refused_no_archive", {
          sessionKey: canonical,
          exitStatus: before.exitStatus
        });
        throw new Error(
          `Refusing to destroy '${canonical}': its process had already exited (status ${before.exitStatus ?? "unknown"}) and the pane could NOT be archived, so tearing it down would take the only record of why with it. Read it with \`tmux capture-pane -p -S -2000 -t ${canonical}\` and remove it by hand.`
        );
      }
      log9.info("tmux_kill_archived_first", {
        sessionKey: canonical,
        archivePath: saved,
        exitStatus: before.exitStatus
      });
    }
    if (!await this.hasSession(canonical)) return;
    const verb = t.kind === "window" ? "kill-window" : "kill-session";
    if (t.kind === "window") {
      const linked = await this.linkedElsewhere(t.windowId);
      if (linked.length > 0) {
        log9.warn("tmux_window_linked_unlinking", { target: t.windowId, linkedSessions: linked });
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
      log9.error("tmux_kill_respawn_detected", { sessionKey: canonical });
      throw new Error(
        `Session '${canonical}' respawned within ${budget}ms after kill \u2014 investigate supervisor (bg-pty-host?)`
      );
    }
  }
  async listSessions() {
    try {
      const { stdout } = await execFileAsync(
        this.tmuxBin,
        ["list-sessions", "-F", "#{session_name}	#{pane_pid}	#{pane_dead}	#{pane_dead_status}"],
        { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
      );
      const records = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, pidStr, deadStr, exitStr] = trimmed.split("	");
        if (!name) continue;
        const parsedPid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN;
        const pid = Number.isNaN(parsedPid) ? null : parsedPid;
        const dead = deadStr === "1";
        const exitStatus = exitStr ? Number.parseInt(exitStr, 10) : Number.NaN;
        records.push({
          // What tmux calls it IS its address — see `trustCanonicalTarget`.
          sessionKey: trustCanonicalTarget(name),
          alive: !dead,
          pid,
          ...dead && pid !== null ? {
            probe: {
              kind: "dead",
              pid,
              exitStatus: Number.isNaN(exitStatus) ? null : exitStatus,
              raw: trimmed
            }
          } : {}
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
   *   1. Refuse payloads that cannot be delivered honestly — see `refusePayload`.
   *      Checked first, so a rejected payload leaves the pane untouched.
   *   2. If the pane is in copy-mode it swallows input — cancel out of it first.
   *   3. CLEAR THE INPUT LINE, and prove it is clear (v0.11.6). See below.
   *   4. Send the TEXT alone and confirm it is visible in the pane. This is the
   *      real check: it proves the keystrokes reached the application while the
   *      line is still uncommitted, so a failure costs nothing.
   *   5. Only then send Enter.
   *
   * ON STEP 3 — why the control plane empties a box it did not fill.
   *
   * These panes belong to people. Someone types half a question, walks away,
   * and the daemon arrives to inject `/compact`. Without step 3 the payload is
   * appended to their sentence and Enter submits the pair: the human loses the
   * thought, and the peer receives a command with a stranger's words glued to
   * the front. Zdeněk's instruction (2026-08-07): clear first, then send —
   * and put it in the tool, not in the callers, because a rule that each caller
   * must remember is a rule that holds until the next caller.
   *
   * What makes it safe to do is Claude Code's own kill ring: `Ctrl+Y` restores
   * a `C-u` exactly, survives an intervening payload, an Enter, and a completed
   * agent turn, and composes across dozens of strokes. The author's objection —
   * that this destroys human work — was measured and is wrong. What remains
   * true is that the human does not KNOW, which is what the two notices in
   * `announceDisplacement` are for.
   *
   * Every attempt is appended to `control/logs/sendkeys-<sessionKey>.log`.
   * Throws when the text cannot be confirmed, so callers surface a hard failure
   * instead of assuming delivery.
   */
  async sendKeys(sessionKey, keys) {
    const refusal = refusePayload(keys);
    if (refusal) {
      log9.error("tmux_send_keys_refused", { sessionKey, reason: refusal.reason });
      throw new Error(`send-keys to '${sessionKey}' refused \u2014 ${refusal.message}`);
    }
    const canonical = formatHostTarget(parseHostTarget(sessionKey));
    const inMode = await this.paneInMode(canonical);
    if (inMode) {
      await this.tmux(["send-keys", "-t", canonical, "-X", "cancel"], SEND_KEYS_TIMEOUT_MS).catch(
        () => void 0
      );
    }
    const cleared = await this.clearInputLine(canonical);
    if (cleared.kind === "stuck") {
      await this.logSendKeys(canonical, {
        keys,
        verdict: "refused-input-not-clear",
        strokes: cleared.strokes,
        draftChars: cleared.draft.length
      });
      log9.error("tmux_send_keys_input_stuck", { sessionKey: canonical, strokes: cleared.strokes });
      throw new Error(
        `send-keys to '${canonical}' refused \u2014 the input line still holds ${cleared.draft.length} characters after ${cleared.strokes} clear strokes, and typing onto a person's unsent text is not an option. Look at the pane: tmux capture-pane -p -t ${canonical}`
      );
    }
    if (cleared.kind === "displaced") await this.announceDisplacement(canonical, keys, cleared);
    let delivered = false;
    let attempts = 0;
    let capturedTail = "";
    let lastError = null;
    let where = "absent";
    for (attempts = 1; attempts <= 2 && !delivered; attempts++) {
      try {
        await this.tmux(["send-keys", "-t", canonical, "-l", "--", keys], SEND_KEYS_TIMEOUT_MS);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      capturedTail = await this.capturePane(canonical);
      const probe = inputLineHolds(capturedTail, keys);
      delivered = probe.delivered;
      where = probe.where;
    }
    await this.logSendKeys(canonical, {
      keys,
      paneInMode: inMode,
      attempts: attempts - 1,
      verdict: delivered ? "delivered" : "not-verified",
      // WHERE the text was, not just whether it was somewhere. `elsewhere-on-pane`
      // is the verdict the pre-v0.11.25 check would have called a success.
      deliveryWhere: where,
      inputLine: cleared.kind,
      clearStrokes: cleared.strokes,
      ...cleared.kind === "displaced" ? { displacedDraft: cleared.draft, restorable: cleared.restorable } : {},
      ...lastError ? { error: lastError } : {},
      capturedTail: capturedTail.slice(-240)
    });
    if (!delivered) {
      log9.error("tmux_send_keys_unverified", {
        sessionKey: canonical,
        attempts: attempts - 1,
        deliveryWhere: where,
        err: lastError
      });
      throw new Error(
        where === "elsewhere-on-pane" ? `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts \u2014 the text IS on the pane but NOT in the input line, so pressing Enter would submit something else. Look at the pane: tmux capture-pane -p -t ${canonical}` : `send-keys to '${canonical}' could not be verified after ${attempts - 1} attempts \u2014 text never reached the input line${lastError ? ` (tmux: ${lastError.split("\n")[0]})` : ""}`
      );
    }
    await this.tmux(["send-keys", "-t", canonical, "Enter"], SEND_KEYS_TIMEOUT_MS);
  }
  /**
   * Empty the input line, and prove it — the hygiene phase of `sendKeys`.
   *
   * `C-u` kills to the start of the DISPLAY row, so a wrapped draft needs one
   * stroke per row; they are sent in batches to keep the round trips down
   * (measured: three in one call kill three rows). A stroke against an already
   * empty box is a no-op that leaves the kill ring intact, so over-sending
   * inside a batch costs nothing.
   *
   * Termination is exact rather than heuristic: the box's content always begins
   * on the marker line and shrinks from the bottom, so the marker line is empty
   * if and only if the whole box is.
   *
   * A pane with no marker at all is not a Claude Code input box — a shell, a
   * pager, a pane still starting. One `C-u` is still sent, because clearing the
   * line is right there too and it is what the instruction asks for, but no
   * verdict is claimed about what was there.
   */
  async clearInputLine(target) {
    const before = readInputLine(await this.capturePane(target));
    if (before.kind === "no-marker") {
      await this.tmux(["send-keys", "-t", target, "C-u"], SEND_KEYS_TIMEOUT_MS).catch(
        () => void 0
      );
      return { kind: "not-an-input-box", draft: "", strokes: 1, restorable: false };
    }
    if (before.kind === "empty") {
      return { kind: "was-empty", draft: "", strokes: 0, restorable: false };
    }
    let strokes = 0;
    let probe = before;
    let captured = "";
    while (strokes < MAX_CLEAR_STROKES) {
      const batch = Math.min(CLEAR_STROKE_BATCH, MAX_CLEAR_STROKES - strokes);
      await this.tmux(
        ["send-keys", "-t", target, ...Array.from({ length: batch }, () => "C-u")],
        SEND_KEYS_TIMEOUT_MS
      ).catch(() => void 0);
      strokes += batch;
      await new Promise((r) => setTimeout(r, this.sendVerifyDelayMs));
      captured = await this.capturePane(target);
      probe = readInputLine(captured);
      if (probe.kind !== "draft") break;
    }
    if (probe.kind === "draft") {
      return { kind: "stuck", draft: probe.text, strokes, restorable: false };
    }
    return {
      kind: "displaced",
      draft: before.text,
      strokes,
      // Claude Code says so itself, in the status row, right after a kill.
      restorable: captured.includes(KILL_RING_HINT)
    };
  }
  /**
   * Tell the human, and tell the record. Two channels, because neither is
   * enough on its own: the status-line notice reaches whoever is sitting there
   * now and vanishes; `events.jsonl` reaches whoever comes back in an hour and
   * finds their sentence gone.
   *
   * What must NOT happen is folding the notice into the payload. The payload is
   * addressed to the application in the pane — for `peer_compact` it is
   * `/compact`, which takes free text as its COMPACTION INSTRUCTIONS, so a
   * sentence meant for a person would silently steer what the peer keeps; for
   * `wake` it is a prompt for the agent. Payload belongs to the application,
   * notices belong to the human, history belongs to the log. Never mixed.
   */
  async announceDisplacement(target, keys, cleared) {
    await this.tmux(
      ["display-message", "-d", String(HUMAN_NOTICE_MS), "-t", target, displacedDraftNotice()],
      SEND_KEYS_TIMEOUT_MS
    ).catch(() => void 0);
    await writeEvent({
      event: "peer_input_displaced",
      level: "warn",
      details: {
        tmuxTarget: target,
        draft: cleared.draft,
        draftChars: cleared.draft.length,
        clearStrokes: cleared.strokes,
        restorableWithCtrlY: cleared.restorable,
        // Which injection displaced it — "who reached into whose window, when".
        payload: keys
      }
    }).catch(() => void 0);
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
  /**
   * Copy what a pane is showing into `control/archive/` and return the path.
   *
   * The order this exists to enforce: ARCHIVE, THEN DESTROY — never the other
   * way, and never destroy without archiving. A tidy-up that deletes takes the
   * explanation with it, which is how the spawn failure of 2026-08-07 became
   * unreproducible: the handler killed the session holding the reason.
   *
   * Returns null if nothing could be captured. A failure to archive is a reason
   * to keep the pane, not a reason to press on.
   */
  async archivePane(sessionKey, reason) {
    const canonical = formatHostTarget(parseHostTarget(sessionKey));
    const content = await this.capturePaneWithHistory(canonical);
    if (content.trim().length === 0) return null;
    try {
      const dir = (0, import_node_path16.join)(controlDir(), "archive");
      await (0, import_promises18.mkdir)(dir, { recursive: true });
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const path = (0, import_node_path16.join)(dir, `pane-${canonical}-${stamp}.log`);
      await (0, import_promises18.appendFile)(
        path,
        `# archived ${(/* @__PURE__ */ new Date()).toISOString()} \u2014 target ${canonical} \u2014 ${reason}
${content}`,
        "utf-8"
      );
      log9.info("pane_archived", { sessionKey: canonical, path, reason });
      return path;
    } catch (e) {
      log9.error("pane_archive_failed", {
        sessionKey: canonical,
        err: e instanceof Error ? e.message : String(e)
      });
      return null;
    }
  }
  /**
   * The pane plus its scrollback, bounded.
   *
   * `capturePane` deliberately stays visible-only — it answers "is the text I
   * just typed on the screen", and history would let a stale copy of the same
   * payload satisfy that check. Archiving wants the opposite: whatever came
   * before, because that is where a failure explains itself.
   *
   * 2000 lines is a compromise. Unbounded (`-S -`) is a peer's entire session
   * and can be enormous; the visible screen alone is routinely empty.
   */
  async capturePaneWithHistory(sessionKey) {
    try {
      const { stdout } = await this.tmux(
        ["capture-pane", "-p", "-S", "-2000", "-t", sessionKey],
        QUERY_TIMEOUT_MS
      );
      return stdout;
    } catch {
      return "";
    }
  }
  async logSendKeys(sessionKey, entry) {
    try {
      const dir = (0, import_node_path16.join)(controlDir(), "logs");
      await (0, import_promises18.mkdir)(dir, { recursive: true });
      const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), sessionKey, ...entry });
      await (0, import_promises18.appendFile)((0, import_node_path16.join)(dir, `sendkeys-${sessionKey}.log`), `${line}
`, "utf-8");
    } catch {
    }
  }
  tmux(args, timeout) {
    return execFileAsync(this.tmuxBin, args, { ...EXEC_DEFAULTS, timeout });
  }
  /**
   * tmux's own vocabulary for "that target is not there".
   *
   * Matched on the message rather than the exit code because tmux exits 1 for
   * everything — a missing session and a broken socket are indistinguishable
   * by status alone. Anything that does not match is treated as IGNORANCE, not
   * as absence, which is the safe direction: mistaking a dead pane for an
   * unreachable one costs a retry, mistaking an unreachable one for a dead
   * pane costs a live peer.
   */
  static NO_SUCH_TARGET = /can't find|no such|not found|no current/i;
  /**
   * Ask the pane what is running in it — and whether anything still is.
   *
   * Three measurements shape this, all taken 2026-08-08 and none of them
   * guessable from the tmux manual:
   *
   * 1. **A dead pane keeps reporting its corpse's pid.** With `remain-on-exit`
   *    a pane whose command exited 42 answered `pane_pid=3791183` while
   *    `/proc/3791183` was already gone. `pane_dead` and `pane_dead_status` are
   *    the honest fields, so all three are read in ONE query — asking
   *    separately would let the pane die between two answers.
   *
   * 2. **`display-message` does not fail on a missing target.** A missing
   *    session and a missing window id both return exit 0, empty stdout, empty
   *    stderr. The `NO_SUCH_TARGET` pattern below therefore almost never fires
   *    on this path: it was written expecting an error message that tmux does
   *    not send. Absence has to be read off the EMPTY ANSWER instead — a live
   *    pane always has a pid, so nothing to say means nothing is there.
   *
   * 3. Absence is still confirmed across retries rather than on the first
   *    empty answer, because a pane queried microseconds after `new-session`
   *    can be invisible for a moment. Death, by contrast, returns immediately:
   *    a pane does not come back to life.
   */
  /** Public second look — see `SessionHostDriver.probePane`. */
  async probePane(sessionKey) {
    return this.probePanePid(formatHostTarget(parseHostTarget(sessionKey)));
  }
  async probePanePid(sessionKey, attempts = 3) {
    let last = "";
    let sawEmpty = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          this.tmuxBin,
          [
            "display-message",
            "-p",
            "-t",
            sessionKey,
            "#{pane_pid}	#{pane_dead}	#{pane_dead_status}"
          ],
          { ...EXEC_DEFAULTS, timeout: QUERY_TIMEOUT_MS }
        );
        const raw = stdout.trim();
        if (raw.length === 0) {
          sawEmpty = true;
          last = "tmux answered with nothing \u2014 the target does not exist";
        } else {
          const [pidStr, deadStr, statusStr] = raw.split("	");
          const parsed = Number.parseInt(pidStr ?? "", 10);
          if (!Number.isNaN(parsed)) {
            if (deadStr === "1") {
              const status = Number.parseInt(statusStr ?? "", 10);
              return {
                kind: "dead",
                pid: parsed,
                exitStatus: Number.isNaN(status) ? null : status,
                raw
              };
            }
            return { kind: "pid", pid: parsed, raw };
          }
          last = `unparseable pane_pid: ${JSON.stringify(raw)}`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stderr = e.stderr ?? "";
        last = `${msg}${stderr ? ` | stderr: ${stderr.trim()}` : ""}`;
        if (_TmuxDriver.NO_SUCH_TARGET.test(last)) return { kind: "no-such-target", raw: last };
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, PROBE_RETRY_PAUSE_MS));
    }
    if (sawEmpty) return { kind: "no-such-target", raw: last };
    return { kind: "unavailable", raw: last, attempts };
  }
  async readSessionPid(sessionKey) {
    const probe = await this.probePanePid(sessionKey);
    return probe.kind === "pid" ? probe.pid : null;
  }
  async verifyKilled(sessionKey, budgetMs) {
    const outcome = await pollUntil(
      async () => await this.hasSession(sessionKey) ? null : true,
      { timeoutMs: budgetMs, pollMs: this.verifyIntervalMs }
    );
    return outcome.kind === "hit" || !await this.hasSession(sessionKey);
  }
};

// src/hosts/mock-driver.ts
var log10 = makeLogger("daemon.host.mock");

// src/hosts/index.ts
function defaultHostDriver() {
  if (process.platform === "win32") {
    throw new Error("Windows native host driver ships in v0.10.0 F3+. Use WSL2 (tmux) for now.");
  }
  return new TmuxDriver();
}

// src/daemon.ts
var log11 = makeLogger("daemon");
var POLL_INTERVAL_MS = 250;
async function runDaemon(opts) {
  try {
    await acquireLock();
  } catch (e) {
    if (e instanceof LockAcquireError) {
      log11.error("lock_held_by_another_daemon", {
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
  const sweptAcks = await sweepAllAcksAtStartup();
  await writeDaemonEvent("daemon_started", {
    daemonVersion: opts.daemonVersion,
    pid: process.pid,
    stateVersion: state.stateVersion,
    peerCount: Object.keys(state.peers).length,
    sweptCompactAcks: sweptAcks
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
    log11.info("sighup_reload_stub", { note: "config reload lands in v0.10.0-beta" });
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
        log11.warn("request_id_filename_mismatch", { fileId, envelopeId: req.id });
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
        if (isPowerOfTwo(skipped)) log11.debug("queue_tick_skipped_busy", { skipped });
      },
      onError: (e) => log11.error("queue_error", { err: String(e) })
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
var import_promises19 = require("node:fs/promises");
var import_node_os4 = require("node:os");
var import_node_path17 = require("node:path");
var log12 = makeLogger("daemon.install");
var UNIT_NAME = "claude-bridge-daemon.service";
function systemdUserDir() {
  return (0, import_node_path17.join)((0, import_node_os4.homedir)(), ".config", "systemd", "user");
}
function unitPath() {
  return (0, import_node_path17.join)(systemdUserDir(), UNIT_NAME);
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
  if (!argv1.startsWith("/")) return (0, import_node_path17.resolve)(process.cwd(), argv1);
  return argv1;
}
async function readTemplate() {
  const anchor = resolveDaemonBin();
  const anchorDir = (0, import_node_path17.dirname)(anchor);
  const candidates = [
    (0, import_node_path17.resolve)(anchorDir, "..", "templates", UNIT_NAME),
    (0, import_node_path17.resolve)(anchorDir, "templates", UNIT_NAME)
  ];
  for (const candidate of candidates) {
    try {
      return await (0, import_promises19.readFile)(candidate, "utf-8");
    } catch {
    }
  }
  throw new Error(`Systemd unit template not found (looked in ${candidates.join(", ")})`);
}
function findNodeBin() {
  return process.execPath;
}
function deployedDaemonPath() {
  return (0, import_node_path17.join)((0, import_node_os4.homedir)(), ".claude-bridge", "bin", "claude-bridge-daemon.cjs");
}
function deployMetaPath() {
  return (0, import_node_path17.join)((0, import_node_path17.dirname)(deployedDaemonPath()), "deployed-from.json");
}
async function deployDaemonBinary(sourceBin) {
  const target = deployedDaemonPath();
  if ((0, import_node_path17.resolve)(sourceBin) === (0, import_node_path17.resolve)(target)) {
    log12.info("deploy_skipped_same_path", { path: target });
    return target;
  }
  await (0, import_promises19.mkdir)((0, import_node_path17.dirname)(target), { recursive: true });
  await (0, import_promises19.copyFile)(sourceBin, target);
  await (0, import_promises19.chmod)(target, 493);
  try {
    const templateSource = await readTemplate();
    const templateTarget = (0, import_node_path17.join)((0, import_node_path17.dirname)(target), "templates", UNIT_NAME);
    await (0, import_promises19.mkdir)((0, import_node_path17.dirname)(templateTarget), { recursive: true });
    await (0, import_promises19.writeFile)(templateTarget, templateSource, "utf-8");
  } catch (e) {
    log12.warn("template_deploy_failed", { err: String(e) });
  }
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      await (0, import_promises19.readFile)((0, import_node_path17.resolve)((0, import_node_path17.dirname)(sourceBin), "..", "package.json"), "utf-8")
    );
    version = pkg.version ?? "unknown";
  } catch {
  }
  await (0, import_promises19.writeFile)(
    deployMetaPath(),
    `${JSON.stringify({ source: (0, import_node_path17.resolve)(sourceBin), version, deployedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`,
    "utf-8"
  );
  log12.info("daemon_binary_deployed", { source: sourceBin, target, version });
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
  await (0, import_promises19.mkdir)(systemdUserDir(), { recursive: true });
  await (0, import_promises19.writeFile)(unitPath(), rendered, "utf-8");
  log12.info("unit_written", { path: unitPath(), execStart: daemonBin });
  runSystemctl("daemon-reload");
  runSystemctl("enable", UNIT_NAME);
  runSystemctl("restart", UNIT_NAME);
  log12.info("daemon_started_via_systemd");
}
async function uninstallSystemd() {
  assertLinux();
  try {
    runSystemctl("stop", UNIT_NAME);
  } catch (e) {
    log12.warn("systemd_stop_failed", { err: String(e) });
  }
  try {
    runSystemctl("disable", UNIT_NAME);
  } catch (e) {
    log12.warn("systemd_disable_failed", { err: String(e) });
  }
  try {
    await (0, import_promises19.unlink)(unitPath());
  } catch (e) {
    const code = e.code;
    if (code !== "ENOENT") log12.warn("unit_unlink_failed", { err: String(e) });
  }
  for (const path of [deployedDaemonPath(), deployMetaPath()]) {
    try {
      await (0, import_promises19.unlink)(path);
    } catch (e) {
      const code = e.code;
      if (code !== "ENOENT") log12.warn("deployed_binary_unlink_failed", { path, err: String(e) });
    }
  }
  runSystemctl("daemon-reload");
  log12.info("uninstalled");
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
      await (0, import_promises19.stat)(path);
    } catch {
      throw new Error(`${label} binary not found at ${path} \u2014 build daemon first (npm run build)`);
    }
  }
}

// src/send.ts
var import_promises20 = require("node:fs/promises");
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
      content = parsed.textFile === "-" ? await readStdin() : await (0, import_promises20.readFile)(parsed.textFile, "utf-8");
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
var log13 = makeLogger("daemon.cli");
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
  config             Read or declare peer intent (see \`config --help\`)
  version            Print the daemon version
  help               Print this message
`;
async function statusCommand() {
  const lock = await readLock();
  let heartbeatAgeMs = null;
  try {
    const s = await (0, import_promises21.stat)(heartbeatPath());
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
    case "config": {
      process.exitCode = await runConfig(argv.slice(1));
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
  log13.error("cli_fatal", { err: String(e) });
  process.exitCode = 1;
});
