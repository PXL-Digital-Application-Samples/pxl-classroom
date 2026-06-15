import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const ajv = addFormats(new Ajv({ allErrors: true }))
const cache = new Map()

export async function validateAgainst(schemaName, doc) {
  if (!cache.has(schemaName)) {
    const url = `${import.meta.env.BASE_URL || '/'}schemas/${schemaName}.schema.json`
    const schema = await (await fetch(url)).json()
    cache.set(schemaName, ajv.compile(schema))
  }
  const validate = cache.get(schemaName)
  return { valid: validate(doc), errors: validate.errors }
}
