const ora = require('ora');

const CLIError = require('./error.js');
const Sync = require('./sync.js');
const validate = require('./validate');

module.exports = async (program) => {
  const log = ora('syncing').start();

  try {
    await exec(program, log);
  } catch (error) {
    throw new CLIError({
      message: error.message,
      stack: error.stack,
      exitCode: 127,
      log
    });
  }
}

async function exec(program, log) {
  if (program.config === undefined) {
    throw new CLIError({
      message: 'config path is not provided',
      exitCode: 127,
      log
    });
  }


  // eslint-disable-next-line
  const config = require(program.config);
  validate(config);

  const sync = new Sync(config);

  return sync.syncGroups().then(() => {
    log.succeed('synced')
  });
}
