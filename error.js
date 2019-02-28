module.exports = class CLIError extends Error {
  constructor(params) {
    super(params);

    // Maintains proper stack trace for
    // where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CLIError);
    }

    if (params.stack) {
      this.stack = params.stack
    }

    this.message = params.message;
    this.log = params.log;
    this.exitCode = params.exitCode;
  }
};
