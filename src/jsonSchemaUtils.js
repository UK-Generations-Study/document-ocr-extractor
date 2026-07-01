import Ajv from 'ajv/dist/2020.js';


/**
 * Checks if a JSON Schema is valid by attempting to validate it using ajv.
 *
 * Uses the draft-2020-12 Ajv build to match the $schema URI declared by
 * schemas in this project. `strict: false` allows the target-style `x-*`
 * annotations (x-version, x-provenance, x-primaryKey, x-enumDescriptions,
 * x-unit, x-description) to pass validation without needing keyword
 * registration.
 *
 * @param jsonSchema
 * @returns {Promise<{valid: *, error: (null|*)}>}
 *         - { valid: true, error: null } if it's valid
 *         - { valid: false, error: "some message" } if it's invalid
 */
async function validateJsonSchema(jsonSchema) {
    const ajv = new Ajv({allErrors: true, strict: false});
    const isValid = ajv.validateSchema(jsonSchema);
    return {
        valid: isValid,
        error: isValid ? null : ajv.errorsText()
    };
}

export {validateJsonSchema};