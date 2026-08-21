import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const ajv = addFormats(new Ajv({ allErrors: true }))
const cache = new Map()

export async function validateAgainst(schemaName, doc) {
  if (!cache.has(schemaName)) {
    cache.set(schemaName, (async () => {
      const url = `${import.meta.env.BASE_URL || '/'}schemas/${schemaName}.schema.json`
      const schema = await (await fetch(url)).json()
      const existing = schema.$id ? ajv.getSchema(schema.$id) : null
      return existing || ajv.compile(schema)
    })())
  }
  const validate = await cache.get(schemaName)
  return { valid: validate(doc), errors: validate.errors }
}
