// Loads variables from .env if present. Must be imported before any other module.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
