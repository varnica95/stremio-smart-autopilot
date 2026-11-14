import { createServer } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadServerConfig } from './config/env.js';
import { createLogger } from './infrastructure/logging/logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadServerConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const app = await createApp(config, logger);
  const server = createServer((req, res) => {
    void app.requestHandler(req, res);
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      { manifest: `${config.publicUrl}/manifest.json`, configure: `${config.publicUrl}/configure` },
      'Smart AutoPilot is running',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      app.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
