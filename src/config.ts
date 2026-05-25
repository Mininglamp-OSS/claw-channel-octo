import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ConfigSchema = z.object({
  octo: z.object({
    botToken: z.string(),
    apiUrl: z.string().default('https://im.deepminer.com.cn/api'),
  }),
  allowedSenders: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const envConfig = {
    octo: {
      botToken: process.env.OCTO_BOT_TOKEN ?? '',
      apiUrl: process.env.OCTO_API_URL ?? 'https://im.deepminer.com.cn/api',
    },
    allowedSenders:
      process.env.OCTO_ALLOWED_SENDERS?.split(',').filter(Boolean) ?? [],
  };

  const configPath = join(homedir(), '.claw-channel-octo', 'config.json');
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      return ConfigSchema.parse({
        octo: {
          ...fileConfig.octo,
          ...Object.fromEntries(
            Object.entries(envConfig.octo).filter(([, v]) => v),
          ),
        },
        allowedSenders:
          envConfig.allowedSenders.length > 0
            ? envConfig.allowedSenders
            : fileConfig.allowedSenders ?? [],
      });
    } catch {
      // Fall through to env-only config
    }
  }

  return ConfigSchema.parse(envConfig);
}
