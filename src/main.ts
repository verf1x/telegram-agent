import { spawn } from 'node:child_process';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from './bot.ts';
import { FileConfigSource } from './config.ts';
import { SqliteStore } from './store.ts';
import { CodexEngine } from './codex/engine.ts';
import { SandboxedAttachmentReader } from './attachments/reader.ts';
import { TelegramApi, TelegramError } from './telegram/transport.ts';

/** Linux flock releases even after SIGKILL; no stale PID-file takeover race. */
async function instanceLock(path: string, onLost: () => void): Promise<() => Promise<void>> {
  const file = await open(path,'a',0o600);
  await file.chmod(0o600);
  await file.close();
  const lock = spawn('flock',['-n','-E','73',path,'/bin/sh','-c','printf "locked\\n"; cat >/dev/null'],{stdio:['pipe','pipe','ignore']});
  let exited = false;
  const exit = new Promise<void>(resolveExit => lock.once('exit',() => { exited = true; resolveExit(); }));
  await new Promise<void>((resolveReady,reject) => {
    lock.once('error',() => reject(new Error('Не удалось запустить flock. Установите util-linux.')));
    lock.once('exit',code => reject(new Error(code === 73 ? 'Бот уже запущен с этим RUNTIME_DIR.' : 'Не удалось получить блокировку процесса.')));
    lock.stdout!.once('data',chunk => {
      if (chunk.toString().startsWith('locked')) resolveReady();
      else reject(new Error('Не удалось получить блокировку процесса.'));
    });
  });
  lock.once('exit',onLost);
  return async () => { if (!exited) { lock.stdin!.end(); await exit; } };
}

async function main(): Promise<void> {
  // Telegram timestamps have one-second precision: ambiguous startup-second messages
  // are conservatively skipped. Keep this cutoff across temporary network failures.
  const startupCutoff = Math.ceil(Date.now() / 1000);
  process.umask(0o077);
  let config: FileConfigSource;
  try { config = new FileConfigSource(resolve('.env')); }
  catch (error) {
    const detail = error instanceof Error && (
      /^(Cannot read \.env configuration file|Invalid \.env (syntax|quoting))$/.test(error.message) ||
      /^Invalid configuration: [A-Z_]+ (must be a positive integer|is out of range|is required|must contain positive numeric IDs)$/.test(error.message)
    ) ? error.message : 'Проверьте обязательные поля и синтаксис .env.';
    throw new Error(`Ошибка конфигурации: ${detail}`);
  }
  const initial = config.snapshot();
  if (!initial.valid) { config.close(); throw new Error(`Ошибка конфигурации: ${initial.error}`); }
  const stop = new AbortController();
  let bot: ReturnType<typeof createBot> | undefined;
  const onSignal = () => {
    stop.abort();
    void bot?.shutdown().catch(() => {});
  };
  process.once('SIGINT',onSignal);
  process.once('SIGTERM',onSignal);
  let unlock: (() => Promise<void>) | undefined;
  let store: SqliteStore | undefined;
  let engine: CodexEngine | undefined;
  let unwatch: (() => void) | undefined;
  try {
    await mkdir(initial.config.runtimeDir,{recursive:true,mode:0o700});
    await chmod(initial.config.runtimeDir,0o700);
    await mkdir(dirname(initial.config.databasePath),{recursive:true,mode:0o700});
    unlock = await instanceLock(resolve(initial.config.runtimeDir,'bot.lock'),onSignal);
    store = new SqliteStore(initial.config.databasePath);
    await chmod(initial.config.databasePath,0o600);
    engine = new CodexEngine({runtimeDir:initial.config.runtimeDir});
    const telegram = new TelegramApi(initial.config.botToken);
    const attachments = new SandboxedAttachmentReader();
    bot = createBot({config,store,engine,telegram,attachments});
    if (stop.signal.aborted) return;
    unwatch = config.watch(snapshot => {
      if (!snapshot.valid) console.error(`Ошибка конфигурации: ${snapshot.error}`);
      else console.info('Конфигурация перечитана.');
    });
    await bot.recover();
    if (stop.signal.aborted) return;
    console.info('Бот запущен. Остановка: Ctrl+C.');
    let startup = true;
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const snapshot = config.snapshot();
        const current = snapshot.valid ? snapshot.config : snapshot.lastValid ?? initial.config;
        const updates = await telegram.getUpdates({offset:store.offset,timeout:startup ? 0 : current.pollTimeoutSeconds,signal:stop.signal});
        for (const update of updates) {
          if (stop.signal.aborted) break;
          if ((update.message && update.message.date < startupCutoff) || (startup && update.callback_query)) {
            await bot.discardOfflineUpdates([update]);
          } else await bot.handleUpdate(update);
        }
        if (updates.length < 100) startup = false;
        failures = 0;
      } catch (error) {
        if (stop.signal.aborted) break;
        failures++;
        // Never print remote descriptions, URLs, raw causes or stack traces.
        console.error(error instanceof TelegramError ? `Telegram недоступен (код ${error.code || 'сети'}). Повтор подключения.` : 'Не удалось обработать обновление. Повтор подключения.');
        const wait = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : Math.min(30_000,1000 * 2 ** Math.min(failures - 1,5));
        await delay(wait,undefined,{signal:stop.signal}).catch(() => {});
      }
    }
  } finally {
    unwatch?.();
    config.close();
    await Promise.allSettled([bot?.shutdown()]);
    await Promise.allSettled([engine?.close()]);
    try { store?.close(); } finally { await unlock?.(); }
    process.removeListener('SIGINT',onSignal);
    process.removeListener('SIGTERM',onSignal);
  }
}

main().catch(error => {
  // Startup failures contain only our own safe diagnostics or validated config errors.
  console.error(error instanceof Error && /^(Ошибка конфигурации:|Бот уже запущен|Не удалось (запустить flock|получить блокировку))/.test(error.message) ? error.message : 'Не удалось запустить бота. Проверьте конфигурацию, права и зависимости.');
  process.exitCode = 1;
});
