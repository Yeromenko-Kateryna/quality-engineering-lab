import { buildApp } from './app';

async function start() {
  await buildApp().listen({ host: '0.0.0.0', port: 3000 });
}

start().catch(error => {
  console.error(`SUT startup failed: ${error.message}`);
  process.exitCode = 1;
});
