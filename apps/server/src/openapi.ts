import * as contracts from '@contentops/contracts'
import type { FastifyDynamicSwaggerOptions, SwaggerTransform } from '@fastify/swagger'
import {
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
} from 'fastify-type-provider-zod'
import type { OpenAPIV3_1 } from 'openapi-types'
import { z } from 'zod'

/**
 * Schemas exported by `@contentops/contracts` become named components (`ItemDetail`,
 * `PlanRowInput` for the request side). Query schemas stay inline: OpenAPI lists their
 * fields as parameters.
 */
const schemaRegistry = z.registry<{ id: string }>()
// Sorted: the order of namespace keys differs between runtimes, the file must not.
const exported = Object.entries(contracts).sort(([a], [b]) => (a < b ? -1 : 1))
for (const [name, value] of exported) {
  if (!(value instanceof z.ZodType) || !name.endsWith('Schema') || schemaRegistry.has(value))
    continue
  if (name.endsWith('QuerySchema') || name === 'NoBodySchema') continue
  schemaRegistry.add(value, { id: name.slice(0, -'Schema'.length) })
}

const routeTransform = createJsonSchemaTransform({ schemaRegistry })
const withComponents = createJsonSchemaTransformObject({ schemaRegistry })

/** Routes sharing a path show the union of their query parameters. */
const transform: SwaggerTransform = (input) => {
  const docQuery = input.route.config?.docQuery
  return routeTransform(
    docQuery ? { ...input, schema: { ...input.schema, querystring: docQuery } } : input,
  )
}

const SCHEMA_REF = '#/components/schemas/'

/** Keeps only the components the paths reach. */
const transformObject: FastifyDynamicSwaggerOptions['transformObject'] = (input) => {
  // Swagger mode is OpenAPI here, never Swagger 2.
  const document = withComponents(input) as OpenAPIV3_1.Document
  const schemas = document.components?.schemas ?? {}
  const used = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith(SCHEMA_REF)) {
        const name = child.slice(SCHEMA_REF.length)
        if (!used.has(name)) {
          used.add(name)
          visit(schemas[name])
        }
      } else {
        visit(child)
      }
    }
  }
  visit(document.paths)
  const kept = Object.entries(schemas)
    .filter(([name]) => used.has(name))
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return { ...document, components: { ...document.components, schemas: Object.fromEntries(kept) } }
}

export const swaggerOptions: FastifyDynamicSwaggerOptions = {
  openapi: { openapi: '3.1.0', info: { title: 'ContentOps API', version: '1' } },
  transform,
  transformObject,
}
