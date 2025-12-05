
import { JSONPath } from 'jsonpath-plus';
import { get, set } from 'lodash';

type MappingItem = {
  description?: string;
  from?: string;               // JSONPath
  literal?: string;            // literal value instead of path
  to: string;                 // dot path, support [] for array append
  default?: any;
  transform?: string;
  args?: any[];               // optional transform args
  separator?: string;         // for concat example
  condition?: {
    operator: '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'exists';
    value?: any;
    path?: string;            // optional: check a different source path
  };
  itemMap?: MappingItem[];    // for array mapping
};

type MappingSpec = {
  $schema?: string;
  version?: string;
  mappings: MappingItem[];
};

type TransformFn = (value: any, ctx: {
  source: any;
  args?: any[];
  separator?: string;
}) => any;

const transforms: Record<string, TransformFn> = {
  isoDateToEpoch: (value: any) => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.getTime();
  },
  toInt: (value: any) => (value == null ? null : parseInt(value, 10)),
  toNumber: (value: any) => (value == null ? null : Number(value)),
  getEnvironmentVariable: (_value: any) => {
    return process.env[_value] ? process.env[_value] || null : null;
  },
  concatFields: (_value: any, ctx) => {
    const [field1, field2] = ctx.args || [];
    const s1 = get(ctx.source, field1);
    const s2 = get(ctx.source, field2);
    const sep = ctx.separator ?? ' ';
    return [s1, s2].filter(v => v != null).join(sep);
  }
};

function evaluateCondition(cond: MappingItem['condition'], source: any, selected: any): boolean {
  if (!cond) return true;
  const operand = cond.path ? get(source, cond.path) : selected;
  switch (cond.operator) {
    case 'exists': return operand !== undefined && operand !== null;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(operand);
    case '>': return operand > cond.value;
    case '>=': return operand >= cond.value;
    case '<': return operand < cond.value;
    case '<=': return operand <= cond.value;
    case '==': return operand == cond.value;
    case '!=': return operand != cond.value;
    default: return true;
  }
}

function applyTransform(name: string | undefined, value: any, source: any, item: MappingItem) {
  if (!name) return value;
  const fn = transforms[name];
  if (!fn) throw new Error(`Unknown transform: ${name}`);
  return fn(value, { source, args: item.args, separator: item.separator });
}

function isArrayAppendPath(path: string) {
  return path.endsWith('[]');
}

function stripArrayAppend(path: string) {
  return path.replace(/\[\]$/, '');
}

export function mapSourceToTarget(source: any, spec: MappingSpec): any {
  const target: any = {};
  for (const item of spec.mappings) {
    // Use literal value if provided, otherwise use JSONPath
    const selected = item.literal !== undefined 
      ? [item.literal]
      : (item.from ? JSONPath({ path: item.from, json: source }) : []);

    // Array mapping
    if (item.itemMap) {
      const arr = Array.isArray(selected) ? selected : [];
      const outPath = stripArrayAppend(item.to);
      const resultArray: any[] = [];

      for (const element of arr) {
        const line: any = {};
        for (const sub of item.itemMap) {
          const subSel = sub.literal !== undefined
            ? [sub.literal]
            : (sub.from ? JSONPath({ path: sub.from, json: element }) : []);
          const raw = subSel?.[0] ?? sub.default;
          if (!evaluateCondition(sub.condition, element, raw)) continue;
          const transformed = applyTransform(sub.transform, raw, element, sub);
          if (transformed !== undefined && transformed !== null) {
            const destPath = isArrayAppendPath(sub.to) ? stripArrayAppend(sub.to) : sub.to;
            set(line, destPath, transformed);
          }
        }
        resultArray.push(line);
      }
      set(target, outPath, resultArray);
      continue;
    }

    // Scalar/collection mapping
    const raw = selected?.[0] ?? item.default;
    if (!evaluateCondition(item.condition, source, raw)) continue;
    const transformed = applyTransform(item.transform, raw, source, item);

    if (transformed !== undefined && transformed !== null) {
      if (isArrayAppendPath(item.to)) {
        const dest = stripArrayAppend(item.to);
        const existing = get(target, dest) ?? [];
        existing.push(transformed);
        set(target, dest, existing);
      } else {
        set(target, item.to, transformed);
      }
    }
  }
  return target;
}
