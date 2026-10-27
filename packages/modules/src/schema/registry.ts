import { checkSchema } from './lint';
import type { ObjectTypeDef, RegisteredType } from './types';

/** Registered object types by full name (`<moduleId>.<name>`). Not shared with the core; the host keeps both in step. */
export class SchemaRegistry {
  private readonly types = new Map<string, RegisteredType>();

  /** Throws on a lint problem (listing all of them) or a duplicate type name. */
  register(module: string, def: ObjectTypeDef): RegisteredType {
    const problems = checkSchema(def);
    if (problems.length) throw new Error(`invalid schema in module "${module}":\n- ${problems.join('\n- ')}`);
    const type = `${module}.${def.name}`;
    const existing = this.types.get(type);
    if (existing) throw new Error(`type "${type}" is already registered by module "${existing.module}" (second registration from module "${module}")`);
    const reg: RegisteredType = { type, module, def, latest: def.versions.length };
    this.types.set(type, reg);
    return reg;
  }

  unregister(type: string): void {
    this.types.delete(type);
  }

  get(type: string): RegisteredType | undefined {
    return this.types.get(type);
  }

  list(): RegisteredType[] {
    return [...this.types.values()];
  }
}
