type DiscriminatedBranch = {
  discriminatorKey: string;
  discriminatorValue: string;
  refSchemaName: string;
};

type OpenApiSchemas = Record<string, any>;

function resolveReference(reference: string, schemas: OpenApiSchemas): any {
  const prefix = "#/components/schemas/";
  return reference.startsWith(prefix) ? schemas[reference.slice(prefix.length)] : undefined;
}

function getReferenceName(reference: string | undefined): string | undefined {
  const prefix = "#/components/schemas/";
  return reference?.startsWith(prefix) ? reference.slice(prefix.length) : undefined;
}

function getSingleValueEnum(property: any, schemas: OpenApiSchemas): string | undefined {
  const propertySchema = property?.$ref ? resolveReference(property.$ref, schemas) : property;
  return propertySchema?.type === "string" &&
    Array.isArray(propertySchema.enum) &&
    propertySchema.enum.length === 1
    ? propertySchema.enum[0]
    : undefined;
}

function getDiscriminatedBranches(
  schema: any,
  schemas: OpenApiSchemas,
): DiscriminatedBranch[] | undefined {
  if (!Array.isArray(schema.oneOf)) return undefined;

  const branches: DiscriminatedBranch[] = [];
  for (const branch of schema.oneOf) {
    // Supported forms:
    //   { allOf: [{ properties: { <disc>: { enum: [val] } } }, { $ref }] }
    //   { $ref: "#/components/schemas/Branch" }
    let refSchemaName: string | undefined;
    let properties: Record<string, any> | undefined;
    if (Array.isArray(branch?.allOf) && branch.allOf.length === 2) {
      const [inline, ref] = branch.allOf;
      refSchemaName = getReferenceName(ref?.$ref);
      properties = inline?.properties;
    } else {
      refSchemaName = getReferenceName(branch?.$ref);
      properties = refSchemaName ? schemas[refSchemaName]?.properties : undefined;
    }

    if (!refSchemaName || !properties || !schemas[refSchemaName]?.properties) return undefined;

    const discEntries = Object.entries(properties)
      .map(([key, property]) => [key, getSingleValueEnum(property, schemas)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
    if (discEntries.length !== 1) return undefined;

    const [discriminatorKey, discriminatorValue] = discEntries[0];
    branches.push({ discriminatorKey, discriminatorValue, refSchemaName });
  }

  return branches.length > 0 ? branches : undefined;
}

export function flattenDiscriminatedUnion(
  name: string,
  schema: any,
  schemas: OpenApiSchemas,
): { schema: any; branchCount: number } | undefined {
  const branches = getDiscriminatedBranches(schema, schemas);
  if (!branches) return undefined;

  // all branches should use the same discriminator key
  const discKey = branches[0].discriminatorKey;
  if (!branches.every((branch) => branch.discriminatorKey === discKey)) return undefined;

  const mergedProperties: Record<string, any> = {
    [discKey]: {
      type: "string",
      enum: branches.map((branch) => branch.discriminatorValue),
    },
  };
  const requiredSets: Set<string>[] = [];

  for (const branch of branches) {
    const branchSchema = schemas[branch.refSchemaName];
    requiredSets.push(new Set<string>(branchSchema.required ?? []));

    for (const [propName, propSchema] of Object.entries<any>(branchSchema.properties)) {
      if (propName === discKey) continue;

      if (!(propName in mergedProperties)) {
        mergedProperties[propName] = structuredClone(propSchema);
      } else {
        // property exists in multiple branches — check for type conflict
        const existing = mergedProperties[propName];
        if (JSON.stringify(existing) !== JSON.stringify(propSchema)) {
          // conflict: fall back to string so specli still exposes the flag
          mergedProperties[propName] = {
            type: "string",
            ...(existing.description ? { description: existing.description } : {}),
            ...(existing.nullable ? { nullable: true } : {}),
          };
        }
      }
    }
  }

  const intersectedRequired =
    requiredSets.length > 0
      ? [...requiredSets[0]].filter((required) => requiredSets.every((set) => set.has(required)))
      : [];
  const required = [discKey, ...intersectedRequired.filter((field) => field !== discKey)];

  // Strip nullable from properties that have no type (specli errors on these)
  for (const propSchema of Object.values<any>(mergedProperties)) {
    if (propSchema.nullable && !propSchema.type) delete propSchema.nullable;
  }

  const patched: any = {
    title: schema.title ?? name,
    type: "object",
    properties: mergedProperties,
  };
  if (required.length > 0) patched.required = required;

  return { schema: patched, branchCount: branches.length };
}
