import { checkAppConfig } from '@sync/modules';
import { loadConfig } from './load-config';

/** Resolve and lint an app config without a browser. Returns every problem (empty means sound). */
export async function checkModules(configPath: string): Promise<string[]> {
  return checkAppConfig(await loadConfig(configPath));
}
