const {validate} = require('jsonschema');

const schema = require('./config.schema');
const CLIError = require('./error');

module.exports = (config, log) => {
  const result = validate(config, schema);

  if (result.errors.length > 0) {
    throw new CLIError({
      message: result,
      exitCode: 127,
      log
    })
  }

  return null;
}

